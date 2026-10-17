import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm, unlink } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { generate } from 'selfsigned'
import { MAX_DOCUMENT_BYTES } from '../../shared/constants'
import type { TeamDevice, TeamPendingRequest } from '../../shared/types'
import { vaultMethods } from '../ipc/methods'
import { friendlyError } from '../services/errors'
import type { Vault } from '../services/vault'
import {
  fingerprintOf,
  isPrivateAddress,
  newPairingCode,
  newToken,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  pairingProof,
  TEAM_PORT
} from './protocol'

const MAX_JSON_BODY = 2 * 1024 * 1024
const MAX_PENDING = 10

interface Pending extends TeamPendingRequest {
  status: 'pending' | 'approved' | 'denied'
  token?: string
  delivered?: boolean
}

interface DeviceRow {
  id: string
  name: string
  token_hash: string
  address: string | null
  created_at: string
  last_seen_at: string | null
  revoked_at: string | null
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * Serves the vault on this PC to paired team PCs over the local network.
 *
 * Security model (spec §9.8): TLS with a self-signed certificate that clients pin; private-network
 * peers only; pairing with a short-lived code that never crosses the wire plus approval on this PC;
 * a random per-device token that can be revoked. All paired devices have equal access by design.
 */
export class TeamHost {
  private server: Server | null = null
  private cert = ''
  private key = ''
  private code: { value: string; expiresAt: number; attempts: number } | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly uploadsDir: string
  private boundPort: number

  constructor(
    private readonly opts: {
      getVault: () => Vault
      dataDir: string
      hostName: string
      port?: number
      /** Tests bind to loopback; the app listens on all interfaces. */
      bind?: string
      now?: () => number
    }
  ) {
    this.boundPort = opts.port ?? TEAM_PORT
    this.uploadsDir = join(opts.dataDir, 'team', 'uploads')
  }

  private get now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  get port(): number {
    return this.boundPort
  }

  get running(): boolean {
    return this.server !== null
  }

  get fingerprint(): string {
    return this.cert ? fingerprintOf(this.cert) : ''
  }

  async start(): Promise<void> {
    if (this.server) return
    await this.ensureCertificate()
    await rm(this.uploadsDir, { recursive: true, force: true })
    mkdirSync(this.uploadsDir, { recursive: true })
    const server = createServer({ cert: this.cert, key: this.key, minVersion: 'TLSv1.2' }, (req, res) => {
      void this.handle(req, res)
    })
    server.headersTimeout = 15_000
    server.requestTimeout = 0
    server.keepAliveTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.boundPort, this.opts.bind ?? '0.0.0.0', () => {
        server.off('error', reject)
        const address = server.address()
        if (address && typeof address === 'object') this.boundPort = address.port
        resolve()
      })
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.code = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  newCode(): { code: string; expiresAt: string } {
    const value = newPairingCode()
    this.code = { value, expiresAt: this.now + PAIRING_TTL_MS, attempts: 0 }
    return { code: value, expiresAt: new Date(this.code.expiresAt).toISOString() }
  }

  currentCode(): { code: string; expiresAt: string } | null {
    if (!this.code || this.code.expiresAt < this.now) return null
    return { code: this.code.value, expiresAt: new Date(this.code.expiresAt).toISOString() }
  }

  pendingRequests(): TeamPendingRequest[] {
    return [...this.pending.values()]
      .filter((p) => p.status === 'pending')
      .map(({ id, deviceName, address, requestedAt }) => ({ id, deviceName, address, requestedAt }))
  }

  approve(id: string): void {
    const request = this.pending.get(id)
    if (!request || request.status !== 'pending') throw new Error('That request is no longer waiting.')
    const token = newToken()
    this.opts
      .getVault()
      .database.prepare(
        'INSERT INTO team_devices (id, name, token_hash, address, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(randomUUID(), request.deviceName, hashToken(token), request.address, new Date(this.now).toISOString())
    request.status = 'approved'
    request.token = token
    // One approval per code: generate a fresh code for the next PC.
    this.code = null
  }

  deny(id: string): void {
    const request = this.pending.get(id)
    if (request) request.status = 'denied'
  }

  devices(): TeamDevice[] {
    const rows = this.opts
      .getVault()
      .database.prepare('SELECT * FROM team_devices WHERE revoked_at IS NULL ORDER BY created_at')
      .all() as DeviceRow[]
    return rows.map((r) => ({ id: r.id, name: r.name, address: r.address, createdAt: r.created_at, lastSeenAt: r.last_seen_at }))
  }

  revoke(id: string): void {
    this.opts
      .getVault()
      .database.prepare('UPDATE team_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date(this.now).toISOString(), id)
  }

  /** LAN IPv4 addresses other PCs can use to reach this one. */
  static lanAddresses(): string[] {
    return Object.values(networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address))
      .map((i) => i!.address)
  }

  private async ensureCertificate(): Promise<void> {
    const dir = join(this.opts.dataDir, 'team')
    const certFile = join(dir, 'host-cert.pem')
    const keyFile = join(dir, 'host-key.pem')
    if (existsSync(certFile) && existsSync(keyFile)) {
      this.cert = readFileSync(certFile, 'utf8')
      this.key = readFileSync(keyFile, 'utf8')
      return
    }
    mkdirSync(dir, { recursive: true })
    const notAfterDate = new Date(this.now)
    notAfterDate.setFullYear(notAfterDate.getFullYear() + 10)
    const pems = await generate([{ name: 'commonName', value: `Agency Project Vault host (${this.opts.hostName})` }], {
      keyType: 'ec',
      algorithm: 'sha256',
      notAfterDate,
      // Clients trust exactly this certificate as their only CA (then also pin its fingerprint).
      // Chromium's BoringSSL, which Electron uses, rejects a pinned self-signed leaf without the CA flag.
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyCertSign: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true }
      ]
    })
    writeFileSync(keyFile, pems.private, { mode: 0o600 })
    writeFileSync(certFile, pems.cert)
    this.cert = pems.cert
    this.key = pems.private
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      if (res.headersSent) return
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    try {
      if (!isPrivateAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Only computers on the local network can connect.')
      const url = new URL(req.url ?? '/', 'https://host')
      const route = `${req.method} ${url.pathname}`

      if (route === 'GET /hello') return send(200, { app: 'agency-project-vault', hostName: this.opts.hostName })
      if (route === 'POST /pair/start') return send(200, this.pairStart(await readJson(req), req.socket.remoteAddress ?? null))
      if (route === 'POST /pair/status') return send(200, this.pairStatus(await readJson(req)))

      this.authenticate(req)
      if (route === 'GET /ping') return send(200, { ok: true, hostName: this.opts.hostName })
      if (route === 'POST /rpc') {
        const body = (await readJson(req)) as { method?: unknown; args?: unknown }
        const methods = vaultMethods(this.opts.getVault())
        if (typeof body.method !== 'string' || !Object.hasOwn(methods, body.method) || !Array.isArray(body.args)) {
          throw new HttpError(400, 'Unknown operation')
        }
        try {
          return send(200, { ok: true, data: await methods[body.method]!(...(body.args as unknown[])) })
        } catch (err) {
          return send(200, { ok: false, error: friendlyError(err) })
        }
      }
      if (route === 'POST /upload') return send(200, await this.upload(req, url))
      const download = url.pathname.match(/^\/download\/([0-9a-f-]{36})$/)
      if (req.method === 'GET' && download) return this.download(download[1]!, res)
      throw new HttpError(404, 'Not found')
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: err.message })
      return send(500, { error: friendlyError(err) })
    }
  }

  private pairStart(body: unknown, address: string | null): { requestId: string; hostProof: string } {
    const { deviceName, nonce, proof } = (body ?? {}) as Record<string, unknown>
    if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 100) throw new HttpError(400, 'Invalid device name')
    if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce) || typeof proof !== 'string') throw new HttpError(400, 'Invalid request')
    const code = this.code
    if (!code || code.expiresAt < this.now) throw new HttpError(403, 'No pairing code is active on the host. Ask for a new code.')
    if (code.attempts >= PAIRING_MAX_ATTEMPTS) throw new HttpError(403, 'Too many wrong codes. Ask for a new code on the host.')
    code.attempts++
    const expected = Buffer.from(pairingProof(code.value, 'client', this.fingerprint, nonce), 'hex')
    const given = Buffer.from(proof, 'hex')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      if (code.attempts >= PAIRING_MAX_ATTEMPTS) this.code = null
      throw new HttpError(403, 'Wrong pairing code.')
    }
    if ([...this.pending.values()].filter((p) => p.status === 'pending').length >= MAX_PENDING) {
      throw new HttpError(429, 'Too many waiting requests on the host.')
    }
    const id = randomUUID()
    this.pending.set(id, {
      id,
      deviceName: deviceName.trim(),
      address,
      requestedAt: new Date(this.now).toISOString(),
      status: 'pending'
    })
    return { requestId: id, hostProof: pairingProof(code.value, 'host', this.fingerprint, nonce) }
  }

  private pairStatus(body: unknown): { status: Pending['status'] | 'unknown'; token?: string } {
    const { requestId } = (body ?? {}) as Record<string, unknown>
    const request = typeof requestId === 'string' ? this.pending.get(requestId) : undefined
    if (!request) return { status: 'unknown' }
    if (request.status === 'approved') {
      // The token is handed over exactly once.
      if (request.delivered) return { status: 'unknown' }
      request.delivered = true
      this.pending.delete(request.id)
      return { status: 'approved', token: request.token }
    }
    if (request.status === 'denied') this.pending.delete(request.id)
    return { status: request.status }
  }

  private authenticate(req: IncomingMessage): void {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token) throw new HttpError(401, 'This PC is not paired with the team vault.')
    const db = this.opts.getVault().database
    const row = db.prepare('SELECT id, revoked_at FROM team_devices WHERE token_hash = ?').get(hashToken(token)) as
      | { id: string; revoked_at: string | null }
      | undefined
    if (!row || row.revoked_at) throw new HttpError(401, 'This PC is not paired with the team vault (it may have been removed on the host).')
    db.prepare('UPDATE team_devices SET last_seen_at = ?, address = ? WHERE id = ?').run(
      new Date(this.now).toISOString(),
      req.socket.remoteAddress ?? null,
      row.id
    )
  }

  private async upload(req: IncomingMessage, url: URL): Promise<unknown> {
    const filename = url.searchParams.get('filename') ?? 'document'
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (!Number.isFinite(declared) || declared > MAX_DOCUMENT_BYTES) throw new HttpError(413, 'File is larger than the 50 MB limit.')
    const tmp = join(this.uploadsDir, `${randomUUID()}.part`)
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length
        if (size > MAX_DOCUMENT_BYTES) return done(new HttpError(413, 'File is larger than the 50 MB limit.'))
        done(null, chunk)
      }
    })
    try {
      await pipeline(req, meter, createWriteStream(tmp, { flags: 'wx' }))
      if (size !== declared) throw new HttpError(400, 'Upload was incomplete.')
      return await this.opts.getVault().documents.registerPick(tmp, { filename, deleteAfterUse: true })
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
  }

  private async download(id: string, res: ServerResponse): Promise<void> {
    const { summary, stream } = this.opts.getVault().documents.openRead(id)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(summary.fileSize),
      'x-sha256': summary.sha256,
      'cache-control': 'no-store'
    })
    await pipeline(stream, res).catch(() => res.destroy())
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_JSON_BODY) throw new HttpError(413, 'Request too large')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}
