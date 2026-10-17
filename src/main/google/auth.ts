import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { z } from 'zod'
import type { KeyProtector } from '../services/encryption'

/**
 * Google sign-in for a desktop app: the system browser opens Google's sign-in page and Google sends
 * the browser back to a one-time server on 127.0.0.1 (OAuth "loopback" flow with PKCE). Only the
 * refresh token is kept, protected with the same OS key protection as the vault key.
 */

/** Files this app creates in the user's Drive, and the account's email. Nothing else in Drive is visible. */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

/** What sync needs from a signed-in Google account. Tests pass a fake. */
export interface GoogleAccount {
  email(): string | null
  signIn(): Promise<string>
  cancelSignIn(): void
  accessToken(): Promise<string>
  signOut(): void
}

const accountSchema = z.object({ email: z.string(), refreshToken: z.string().min(1) })
const tokenSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional()
})

const base64url = (b: Buffer): string => b.toString('base64url')

export class SignedOutError extends Error {}

export class GoogleAuth implements GoogleAccount {
  private access: { token: string; expiresAt: number } | null = null
  private pending: { server: Server; reject: (err: Error) => void } | null = null

  constructor(
    private readonly opts: {
      dataDir: string
      protector: KeyProtector
      client: GoogleClient
      openExternal: (url: string) => Promise<void> | void
      fetch?: typeof fetch
      now?: () => number
    }
  ) {}

  private get file(): string {
    return join(this.opts.dataDir, 'google', 'account.json')
  }

  private get fetch(): typeof fetch {
    return this.opts.fetch ?? fetch
  }

  private saved(): z.infer<typeof accountSchema> | null {
    try {
      return accountSchema.parse(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  email(): string | null {
    return this.saved()?.email ?? null
  }

  /** Opens Google's sign-in page in the browser and waits for the user to finish there. */
  async signIn(): Promise<string> {
    const { clientId, clientSecret } = this.opts.client
    if (!clientId) throw new Error('Google sign-in is not set up in this build yet.')
    this.cancelSignIn()
    const verifier = base64url(randomBytes(32))
    const state = base64url(randomBytes(16))
    const { code, redirectUri } = await this.waitForCode(state, (redirectUri) => {
      const url = new URL(AUTH_URL)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        code_challenge: base64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state,
        access_type: 'offline',
        // Always ask, so Google returns a refresh token even if this account signed in before.
        prompt: 'consent select_account'
      }).toString()
      return url.toString()
    })
    const tokens = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret
    })
    if (!tokens.refresh_token) throw new Error('Google did not allow offline access. Please try signing in again.')
    const email = tokens.id_token ? emailFromIdToken(tokens.id_token) : null
    if (!email) throw new Error('Google did not share the account email. Please try signing in again.')
    this.remember(tokens)
    mkdirSync(join(this.opts.dataDir, 'google'), { recursive: true })
    const protectedToken = this.opts.protector.protect(Buffer.from(tokens.refresh_token, 'utf8')).toString('base64')
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ email, refreshToken: protectedToken }), { mode: 0o600 })
    renameSync(`${this.file}.tmp`, this.file)
    return email
  }

  cancelSignIn(): void {
    const pending = this.pending
    this.pending = null
    pending?.reject(new Error('Sign-in was cancelled.'))
  }

  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(): Promise<string> {
    const now = this.opts.now?.() ?? Date.now()
    if (this.access && this.access.expiresAt - 60_000 > now) return this.access.token
    const saved = this.saved()
    if (!saved) throw new SignedOutError('Not signed in to Google.')
    let refreshToken: string
    try {
      refreshToken = this.opts.protector.unprotect(Buffer.from(saved.refreshToken, 'base64')).toString('utf8')
    } catch {
      throw new SignedOutError('Google sign-in cannot be read on this Windows account. Sign in again.')
    }
    const tokens = await this.token({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.opts.client.clientId,
      client_secret: this.opts.client.clientSecret
    })
    return this.remember(tokens)
  }

  signOut(): void {
    this.cancelSignIn()
    this.access = null
    if (existsSync(this.file)) unlinkSync(this.file)
  }

  private remember(tokens: z.infer<typeof tokenSchema>): string {
    this.access = { token: tokens.access_token, expiresAt: (this.opts.now?.() ?? Date.now()) + tokens.expires_in * 1000 }
    return tokens.access_token
  }

  private async token(form: Record<string, string>): Promise<z.infer<typeof tokenSchema>> {
    let res: Response
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString()
      })
    } catch {
      throw new Error('Cannot reach Google. Check the internet connection.')
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
    if (!res.ok) {
      if (body.error === 'invalid_grant') throw new SignedOutError('Google sign-in has expired or was removed. Sign in again.')
      throw new Error(`Google sign-in failed: ${body.error_description ?? body.error ?? res.status}`)
    }
    return tokenSchema.parse(body)
  }

  /** Starts the one-time loopback server, opens the browser and resolves with the code Google sends back. */
  private waitForCode(state: string, authUrl: (redirectUri: string) => string): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let redirectUri = ''
      const finish = (err: Error | null, code?: string): void => {
        clearTimeout(timer)
        server.close()
        if (this.pending?.server === server) this.pending = null
        if (err) reject(err)
        else resolve({ code: code!, redirectUri })
      }
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const ok = url.searchParams.get('state') === state && !!url.searchParams.get('code')
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(page(ok ? 'Signed in. You can close this tab and go back to Agency Project Vault.' : 'Sign-in did not finish. Go back to the app and try again.'))
        if (url.searchParams.get('state') !== state) return
        if (ok) finish(null, url.searchParams.get('code')!)
        else finish(new Error(url.searchParams.get('error') === 'access_denied' ? 'Sign-in was cancelled in the browser.' : 'Google sign-in failed.'))
      })
      const timer = setTimeout(() => finish(new Error('Sign-in timed out. Please try again.')), SIGN_IN_TIMEOUT_MS)
      this.pending = { server, reject: (err) => finish(err) }
      server.on('error', (err) => finish(err))
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') return finish(new Error('Could not start sign-in.'))
        redirectUri = `http://127.0.0.1:${address.port}`
        Promise.resolve(this.opts.openExternal(authUrl(redirectUri))).catch((err: unknown) =>
          finish(err instanceof Error ? err : new Error('Could not open the browser.'))
        )
      })
    })
  }
}

function emailFromIdToken(idToken: string): string | null {
  try {
    // Received straight from Google's token endpoint over TLS, so its signature need not be checked here.
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

const page = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Agency Project Vault</title><body style="font:16px system-ui;padding:48px;text-align:center"><h2>Agency Project Vault</h2><p>${message}</p></body>`
