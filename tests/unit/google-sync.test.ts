import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GoogleAuth, SignedOutError, type GoogleAccount } from '../../src/main/google/auth'
import { importClientFile, loadGoogleClient, parseClientFile } from '../../src/main/google/client'
import { createBackup, readBackup, swapInStaged } from '../../src/main/services/backup'
import { unprotectedKeys } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'
import { readTeamConfig } from '../../src/main/team/config'
import { TeamController } from '../../src/main/team/controller'

/** An in-memory Google Drive answering the REST calls the app makes. */
interface FakeFile {
  id: string
  name: string
  parents: string[]
  mimeType: string
  appProperties: Record<string, string>
  data: Buffer
  createdTime: number
  modifiedTime: number
  trashed: boolean
}

function fakeDrive(): { fetch: typeof fetch; files: Map<string, FakeFile>; offline: boolean; requests: number } {
  const files = new Map<string, FakeFile>()
  let clock = 1_000
  const state = { fetch: null as unknown as typeof fetch, files, offline: false, requests: 0 }
  const meta = (f: FakeFile): Record<string, unknown> => ({
    id: f.id,
    name: f.name,
    trashed: f.trashed,
    md5Checksum: createHash('md5').update(f.data).digest('hex'),
    modifiedTime: new Date(f.modifiedTime).toISOString()
  })
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.offline) throw new TypeError('fetch failed')
    state.requests++
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers.authorization !== 'Bearer token-ok') return json({ error: { message: 'Invalid Credentials' } }, 401)
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? Buffer.alloc(0) : Buffer.from(init.body as Buffer | string)
    const idMatch = url.pathname.match(/\/files\/([^/]+)$/)
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      let list = [...files.values()].filter((f) => !f.trashed)
      const parent = q.match(/'([^']+)' in parents/)?.[1]
      if (parent) list = list.filter((f) => f.parents.includes(parent))
      const prop = q.match(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/)
      if (prop) list = list.filter((f) => f.appProperties[prop[1]!] === prop[2])
      const order = url.searchParams.get('orderBy') === 'createdTime' ? 'createdTime' : 'modifiedTime'
      list.sort((a, b) => a[order] - b[order])
      return json({ files: list.map(meta) })
    }
    if (url.pathname === '/drive/v3/files' && method === 'POST') {
      const m = JSON.parse(body.toString()) as { name: string; mimeType: string; appProperties: Record<string, string> }
      const f: FakeFile = { id: randomUUID(), name: m.name, parents: ['root'], mimeType: m.mimeType, appProperties: m.appProperties, data: Buffer.alloc(0), createdTime: ++clock, modifiedTime: clock, trashed: false }
      files.set(f.id, f)
      return json({ id: f.id })
    }
    if (idMatch && url.pathname.startsWith('/drive/v3/') && method === 'GET') {
      const f = files.get(decodeURIComponent(idMatch[1]!))
      if (!f) return json({ error: { message: 'File not found' } }, 404)
      return url.searchParams.get('alt') === 'media' ? new Response(f.data) : json(meta(f))
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const boundary = String(headers['content-type']).split('boundary=')[1]!
      const parts = body.toString('latin1').split(`--${boundary}`)
      const m = JSON.parse(parts[1]!.split('\r\n\r\n')[1]!.trim()) as { name: string; parents: string[] }
      const raw = parts[2]!.slice(parts[2]!.indexOf('\r\n\r\n') + 4, -2)
      const f: FakeFile = { id: randomUUID(), name: m.name, parents: m.parents, mimeType: 'application/octet-stream', appProperties: {}, data: Buffer.from(raw, 'latin1'), createdTime: ++clock, modifiedTime: clock, trashed: false }
      files.set(f.id, f)
      return json(meta(f))
    }
    if (idMatch && url.pathname.startsWith('/upload/') && method === 'PATCH') {
      const f = files.get(decodeURIComponent(idMatch[1]!))
      if (!f) return json({ error: { message: 'File not found' } }, 404)
      f.data = body
      f.modifiedTime = ++clock
      return json(meta(f))
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 400)
  }) as typeof fetch
  return state
}

function fakeGoogle(email = 'agency@gmail.com'): GoogleAccount & { signIns: number; expired: boolean } {
  let signedIn: string | null = null
  return {
    signIns: 0,
    expired: false,
    configured: () => true,
    email: () => signedIn,
    async signIn() {
      this.signIns++
      this.expired = false
      signedIn = email
      return email
    },
    cancelSignIn: () => undefined,
    async accessToken() {
      if (!signedIn) throw new SignedOutError('Not signed in to Google. Sign in again.')
      if (this.expired) throw new SignedOutError('Google sign-in has expired or was removed. Sign in again.')
      return 'token-ok'
    },
    signOut: () => {
      signedIn = null
    }
  }
}

interface Pc {
  dir: string
  vault: Vault
  team: TeamController
  google: ReturnType<typeof fakeGoogle>
  changes: number
}

let root: string
let drive: ReturnType<typeof fakeDrive>
const pcs: Pc[] = []

function pc(name: string, google = fakeGoogle()): Pc {
  const dir = join(root, name)
  const created: Pc = { dir, vault: Vault.open(dir, unprotectedKeys), team: null as never, google, changes: 0 }
  created.team = controllerFor(created)
  pcs.push(created)
  return created
}

function controllerFor(p: Pc): TeamController {
  return new TeamController({
    dataDir: p.dir,
    protector: unprotectedKeys,
    getVault: () => p.vault,
    hostName: 'pc',
    syncIntervalMs: 3_600_000,
    google: p.google,
    driveFetch: drive.fetch,
    reopenVault: () => {
      p.vault.close()
      p.vault = Vault.open(p.dir, unprotectedKeys)
    },
    onRemoteChange: () => p.changes++
  })
}

const sync = async (...list: Pc[]): Promise<void> => {
  for (const p of list) await p.team.syncNow()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apv-google-'))
  drive = fakeDrive()
})
afterEach(async () => {
  for (const p of pcs.splice(0)) {
    await p.team.close()
    p.vault.close()
  }
  rmSync(root, { recursive: true, force: true })
})

describe('team sync through Google Drive with only a Google sign-in', () => {
  it('shares everything between PCs signed in to the same Google account, with no folder or passphrase', async () => {
    const a = pc('A')
    const project = a.vault.projects.create({ name: 'Telecom' })
    a.vault.credentials.save({ projectId: project.id, serviceName: 'cPanel', username: 'admin', password: 'Drive-Canary-55' })
    const src = join(root, 'contract.txt')
    writeFileSync(src, 'signed contract')
    const pick = await a.vault.documents.registerPick(src)
    await a.vault.documents.create({ projectId: project.id, fileToken: pick.token, metadata: { displayName: 'Contract', purpose: 'legal' } })

    expect(await a.team.connectGoogle()).toMatchObject({ role: 'google', email: 'agency@gmail.com', error: null })
    expect(a.team.role).toBe('google')
    const names = [...drive.files.values()].map((f) => f.name)
    expect(names).toContain('Agency Project Vault')
    expect(names).toContain('team.json')

    // B had its own data and key; signing in is all it does.
    const b = pc('B')
    const own = b.vault.projects.create({ name: 'B before sign-in' })
    b.vault.credentials.save({ projectId: own.id, serviceName: 'GitHub', password: 'B-Secret-77' })
    expect(await b.team.connectGoogle()).toMatchObject({ role: 'google', error: null })
    expect(readTeamConfig(b.dir)).toMatchObject({ role: 'google', email: 'agency@gmail.com' })
    expect(b.vault.projects.list().map((p) => p.name).sort()).toEqual(['B before sign-in', 'Telecom'])
    const [cred] = b.vault.credentials.list(project.id)
    expect(b.vault.credentials.reveal(cred!.id, 'password')).toBe('Drive-Canary-55')
    expect(b.vault.credentials.reveal(b.vault.credentials.list(own.id)[0]!.id, 'password')).toBe('B-Secret-77')
    const out = join(root, 'exported.txt')
    await b.vault.documents.exportTo(b.vault.documents.list(project.id)[0]!.id, out)
    expect(readFileSync(out, 'utf8')).toBe('signed contract')

    // Edits go both ways; deletes too.
    await sync(a)
    expect(a.vault.projects.list().map((p) => p.name).sort()).toEqual(['B before sign-in', 'Telecom'])
    expect(a.changes).toBeGreaterThan(0)
    const onB = b.vault.projects.require(project.id)
    b.vault.projects.update({ id: project.id, revision: onB.revision, input: { name: 'Telecom (edited on B)' } })
    await sync(b, a)
    expect(a.vault.projects.require(project.id).name).toBe('Telecom (edited on B)')
    await a.vault.deleteProject(own.id)
    await sync(a, b)
    expect(b.vault.projects.get(own.id)).toBeNull()

    // Drive holds no plaintext.
    for (const f of drive.files.values()) {
      for (const plain of ['Drive-Canary-55', 'B-Secret-77', 'signed contract', 'Telecom', 'cPanel']) {
        expect(f.data.includes(Buffer.from(plain))).toBe(false)
      }
    }

    // A restart resumes syncing without asking anything.
    await a.team.close()
    b.vault.projects.create({ name: 'After restart' })
    await sync(b)
    const restarted = controllerFor(pcs[0]!)
    await restarted.init()
    expect(restarted.role).toBe('google')
    expect(await restarted.syncNow()).toMatchObject({ role: 'google', error: null })
    expect(a.vault.projects.list().map((p) => p.name)).toContain('After restart')
    await restarted.close()
  })

  it('reports offline and removed folders, signs out, and moves a shared-folder team over', async () => {
    const a = pc('A')
    await a.team.createFolderTeam({ folder: join(root, 'Drive'), teamName: 'Old', passphrase: 'old team passphrase' })
    a.vault.projects.create({ name: 'From folder team' })
    expect(await a.team.connectGoogle()).toMatchObject({ role: 'google' })
    expect(a.google.signIns).toBe(1)
    const b = pc('B')
    await b.team.connectGoogle()
    expect(b.vault.projects.list().map((p) => p.name)).toEqual(['From folder team'])

    drive.offline = true
    expect(await b.team.syncNow()).toMatchObject({ error: expect.stringMatching(/Cannot reach Google Drive/) })
    drive.offline = false
    expect(await b.team.syncNow()).toMatchObject({ error: null })

    for (const f of drive.files.values()) if (f.name === 'Agency Project Vault') f.trashed = true
    expect(await b.team.syncNow()).toMatchObject({ error: expect.stringMatching(/folder was removed/) })

    expect(await b.team.signOutGoogle()).toEqual({ role: 'personal' })
    expect(readTeamConfig(b.dir)).toEqual({ role: 'personal' })
    expect(b.google.email()).toBeNull()
    expect(b.vault.projects.list().map((p) => p.name)).toEqual(['From folder team'])
  })
})

describe('Google sign-in', () => {
  const idToken = (email: string): string => `x.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.sig`

  function tokenServer(): { fetch: typeof fetch; forms: URLSearchParams[]; revoked: boolean } {
    const state = { fetch: null as unknown as typeof fetch, forms: [] as URLSearchParams[], revoked: false }
    state.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== 'https://oauth2.googleapis.com/token') return new Response('nope', { status: 404 })
      const form = new URLSearchParams(String(init?.body))
      state.forms.push(form)
      if (form.get('grant_type') === 'refresh_token') {
        if (state.revoked || form.get('refresh_token') !== 'refresh-1') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        return new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }))
      }
      return new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', id_token: idToken('agency@gmail.com') }))
    }) as typeof fetch
    return state
  }

  it('signs in through the browser, keeps only a protected refresh token, and refreshes access', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apv-auth-'))
    const google = tokenServer()
    let now = 0
    let opened = ''
    const auth = new GoogleAuth({
      dataDir: dir,
      protector: unprotectedKeys,
      client: { clientId: 'client-1', clientSecret: 'secret-1' },
      fetch: google.fetch,
      now: () => now,
      openExternal: async (url) => {
        opened = url
        const u = new URL(url)
        // The browser lands on the loopback page after the user approves.
        const res = await fetch(`${u.searchParams.get('redirect_uri')}/?code=auth-code&state=${u.searchParams.get('state')}`)
        expect(await res.text()).toMatch(/Signed in/)
      }
    })
    expect(auth.email()).toBeNull()
    expect(await auth.signIn()).toBe('agency@gmail.com')
    const u = new URL(opened)
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/drive.file')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    const exchange = google.forms[0]!
    expect(exchange.get('code')).toBe('auth-code')
    expect(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url')).toBe(u.searchParams.get('code_challenge'))
    expect(auth.email()).toBe('agency@gmail.com')
    expect(readFileSync(join(dir, 'google', 'account.json'), 'utf8')).not.toContain('access-1')

    expect(await auth.accessToken()).toBe('access-1')
    now = 3_600_000
    expect(await auth.accessToken()).toBe('access-2')
    google.revoked = true
    now = 7_200_000
    await expect(auth.accessToken()).rejects.toBeInstanceOf(SignedOutError)
    auth.signOut()
    expect(existsSync(join(dir, 'google', 'account.json'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('can be cancelled and refuses to run without a client id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apv-auth-'))
    const noClient = new GoogleAuth({ dataDir: dir, protector: unprotectedKeys, client: { clientId: '', clientSecret: '' }, openExternal: () => undefined })
    await expect(noClient.signIn()).rejects.toThrow(/not set up/)
    const auth = new GoogleAuth({ dataDir: dir, protector: unprotectedKeys, client: { clientId: 'c', clientSecret: 's' }, openExternal: () => undefined })
    const pending = auth.signIn()
    await new Promise((r) => setTimeout(r, 50))
    auth.cancelSignIn()
    await expect(pending).rejects.toThrow(/cancelled/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('Google Drive backups and expired sign-ins', () => {
  it('backs up to Drive on one PC and restores on another, which then republishes to the team', async () => {
    const a = pc('A')
    const project = a.vault.projects.create({ name: 'Backed up' })
    a.vault.credentials.save({ projectId: project.id, serviceName: 'cPanel', password: 'Backup-Canary-9' })
    await a.team.connectGoogle()
    const temp = join(root, 'a.apv')
    await createBackup({ db: a.vault.database, dataDir: a.vault.dataDir, encryptor: a.vault.encryptor, destPath: temp, passphrase: 'backup passphrase', appVersion: 'test' })
    await a.team.uploadDriveBackup('AgencyProjectVault-backup-2026-10-17T22-00-00-000Z.apv', readFileSync(temp))
    await expect(a.team.uploadDriveBackup('../evil.apv', Buffer.from('x'))).rejects.toThrow(/Invalid backup name/)

    // A loses the project; B (signed in to the same account) restores the Drive backup.
    await a.vault.deleteProject(project.id)
    await sync(a)
    const b = pc('B')
    await b.team.connectGoogle()
    expect(b.vault.projects.list()).toEqual([])
    const [name] = await b.team.listDriveBackups()
    expect(name).toBe('AgencyProjectVault-backup-2026-10-17T22-00-00-000Z.apv')
    const downloaded = join(root, 'b.apv')
    writeFileSync(downloaded, await b.team.downloadDriveBackup(name!))
    const staged = await readBackup(downloaded, 'backup passphrase', join(b.dir, '.restore-test'))
    await b.team.pauseSync()
    b.vault.close()
    swapInStaged(b.dir, staged, unprotectedKeys)
    b.vault = Vault.open(b.dir, unprotectedKeys)
    await b.team.resumeAfterRestore()
    const cred = b.vault.credentials.list(project.id)[0]!
    expect(b.vault.credentials.reveal(cred.id, 'password')).toBe('Backup-Canary-9')

    // The restored project reaches A again.
    await sync(a)
    expect(a.vault.projects.list().map((p) => p.name)).toEqual(['Backed up'])
    expect(a.vault.credentials.reveal(a.vault.credentials.list(project.id)[0]!.id, 'password')).toBe('Backup-Canary-9')
  })

  it('asks to sign in again when the Google sign-in expires, then carries on', async () => {
    const a = pc('A')
    await a.team.connectGoogle()
    a.google.expired = true
    a.vault.projects.create({ name: 'Made while expired' })
    expect(await a.team.syncNow()).toMatchObject({ role: 'google', error: expect.stringMatching(/Sign in again/) })
    expect(await a.team.connectGoogle()).toMatchObject({ role: 'google', error: null })
    expect(a.google.signIns).toBe(2)
    const b = pc('B')
    await b.team.connectGoogle()
    expect(b.vault.projects.list().map((p) => p.name)).toEqual(['Made while expired'])
  })
})

describe('Google OAuth client file', () => {
  const file = (o: unknown): string => JSON.stringify(o)
  const id = '1234567890-abc.apps.googleusercontent.com'

  it('reads the file Google Cloud downloads, from env, the data folder or next to the app', () => {
    expect(parseClientFile(file({ installed: { client_id: id, client_secret: 'GOCSPX-x', redirect_uris: ['http://localhost'] } }))).toEqual({ clientId: id, clientSecret: 'GOCSPX-x' })
    expect(() => parseClientFile(file({ installed: { client_id: 'nope', client_secret: 's' } }))).toThrow(/not a Google OAuth client file/)
    expect(() => parseClientFile('{')).toThrow(/not a Google OAuth client file/)

    const dataDir = join(root, 'data')
    const exeDir = join(root, 'exe')
    expect(loadGoogleClient(dataDir, exeDir, {})).toEqual({ clientId: '', clientSecret: '' })
    const picked = join(root, 'client_secret_123.json')
    writeFileSync(picked, file({ installed: { client_id: id, client_secret: 'GOCSPX-picked' } }))
    importClientFile(dataDir, picked)
    expect(loadGoogleClient(dataDir, exeDir, {})).toEqual({ clientId: id, clientSecret: 'GOCSPX-picked' })
    expect(loadGoogleClient(dataDir, exeDir, { APV_GOOGLE_CLIENT_ID: 'env-id', APV_GOOGLE_CLIENT_SECRET: 'env-secret' })).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' })
    expect(loadGoogleClient(join(root, 'none'), exeDir, { APV_GOOGLE_OAUTH_FILE: picked })).toEqual({ clientId: id, clientSecret: 'GOCSPX-picked' })
  })
})
