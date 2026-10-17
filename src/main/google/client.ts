import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { GoogleClient } from './auth'

/**
 * Where the app's Google OAuth client ("Desktop app" type) comes from, first match wins:
 *  1. APV_GOOGLE_CLIENT_ID / APV_GOOGLE_CLIENT_SECRET, or a JSON file named by APV_GOOGLE_OAUTH_FILE
 *  2. google-oauth.json in the app's data folder (imported from Settings on this PC)
 *  3. google-oauth.json next to the installed .exe
 *  4. values built into the installer from the repository's GitHub Actions secrets
 * Nothing is kept in the source code. For installed apps Google does not treat the client secret as
 * confidential; PKCE protects each sign-in.
 */
export const OAUTH_FILE = 'google-oauth.json'

declare const __APV_GOOGLE_CLIENT_ID__: string
declare const __APV_GOOGLE_CLIENT_SECRET__: string
const builtIn = (): GoogleClient => ({
  clientId: typeof __APV_GOOGLE_CLIENT_ID__ === 'string' ? __APV_GOOGLE_CLIENT_ID__ : '',
  clientSecret: typeof __APV_GOOGLE_CLIENT_SECRET__ === 'string' ? __APV_GOOGLE_CLIENT_SECRET__ : ''
})

const entry = z.object({
  client_id: z.string().regex(/\.apps\.googleusercontent\.com$/, 'not a Google OAuth client id'),
  client_secret: z.string().min(1)
})
const fileSchema = z.union([z.object({ installed: entry }), z.object({ web: entry }), entry])

/** Reads Google's downloaded client JSON ({"installed": {...}}) or a flat {client_id, client_secret}. */
export function parseClientFile(text: string): GoogleClient {
  let parsed: z.infer<typeof fileSchema>
  try {
    parsed = fileSchema.parse(JSON.parse(text))
  } catch {
    throw new Error('This is not a Google OAuth client file. Download it from Google Cloud → Credentials → your Desktop client → Download JSON.')
  }
  const e = 'installed' in parsed ? parsed.installed : 'web' in parsed ? parsed.web : parsed
  return { clientId: e.client_id, clientSecret: e.client_secret }
}

export function loadGoogleClient(dataDir: string, exeDir: string | null, env: NodeJS.ProcessEnv = process.env): GoogleClient {
  if (env.APV_GOOGLE_CLIENT_ID) return { clientId: env.APV_GOOGLE_CLIENT_ID, clientSecret: env.APV_GOOGLE_CLIENT_SECRET ?? '' }
  const files = [env.APV_GOOGLE_OAUTH_FILE, join(dataDir, OAUTH_FILE), exeDir ? join(exeDir, OAUTH_FILE) : undefined]
  for (const file of files) {
    if (file && existsSync(file)) return parseClientFile(readFileSync(file, 'utf8'))
  }
  return builtIn()
}

/** Copies a client JSON the user picked into the app's data folder, readable only by this user. */
export function importClientFile(dataDir: string, sourcePath: string): GoogleClient {
  const client = parseClientFile(readFileSync(sourcePath, 'utf8'))
  mkdirSync(dataDir, { recursive: true })
  const target = join(dataDir, OAUTH_FILE)
  writeFileSync(`${target}.tmp`, JSON.stringify({ installed: { client_id: client.clientId, client_secret: client.clientSecret } }), { mode: 0o600 })
  renameSync(`${target}.tmp`, target)
  return client
}
