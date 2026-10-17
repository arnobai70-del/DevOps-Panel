import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat, unlink } from 'node:fs/promises'
import { Agent, request, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { PeerCertificate, TLSSocket } from 'node:tls'
import { basename } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { PickedFile } from '../../shared/types'
import { fingerprintOf, newNonce, pairingProof } from './protocol'

const REQUEST_TIMEOUT_MS = 15_000
const TRANSFER_IDLE_TIMEOUT_MS = 30_000

export interface HostEndpoint {
  address: string
  port: number
}

export interface PinnedHost extends HostEndpoint {
  certPem: string
  fingerprint: string
}

export class TeamOfflineError extends Error {
  constructor(host: string) {
    super(`Team Vault offline: cannot reach the host PC (${host}). Make sure it is switched on, the app is open, and you are on the same network.`)
    this.name = 'TeamOfflineError'
  }
}

const CERT_CHANGED =
  'The host PC presented a different certificate. Re-join the team vault if the host was reinstalled.'
const TLS_VERIFY_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID'
])

/** HTTPS agent that only talks to the host whose certificate fingerprint we pinned at pairing. */
function pinnedAgent(host: PinnedHost): Agent {
  return new Agent({
    keepAlive: true,
    maxSockets: 8,
    ca: host.certPem,
    checkServerIdentity: (_name: string, cert: PeerCertificate) =>
      cert.fingerprint256 === host.fingerprint ? undefined : new Error(CERT_CHANGED)
  })
}

interface Response {
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}

function send(
  endpoint: HostEndpoint,
  opts: RequestOptions & { body?: Buffer | NodeJS.ReadableStream; timeoutMs?: number; raw?: (res: IncomingMessage) => Promise<void> }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request({ host: endpoint.address, port: endpoint.port, ...opts }, (res) => {
      if (opts.raw && res.statusCode === 200) {
        opts.raw(res).then(() => resolve({ status: 200, headers: res.headers, body: Buffer.alloc(0) }), reject)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.setTimeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, () => req.destroy(new TeamOfflineError(endpoint.address)))
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof TeamOfflineError) return reject(err)
      if (TLS_VERIFY_ERRORS.has(err.code ?? '') || err.message === CERT_CHANGED) return reject(new Error(CERT_CHANGED))
      if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code ?? '')) {
        return reject(new TeamOfflineError(endpoint.address))
      }
      reject(err)
    })
    const body = opts.body
    if (body && !Buffer.isBuffer(body)) {
      pipeline(body, req).catch((err: Error) => req.destroy(err))
    } else {
      req.end(body)
    }
  })
}

function json(res: Response): Record<string, unknown> {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new Error(`Unexpected reply from the host (HTTP ${res.status}).`)
  }
  if (res.status !== 200) throw new Error(typeof parsed.error === 'string' ? parsed.error : `Host error (HTTP ${res.status}).`)
  return parsed
}

const jsonBody = (value: unknown): { body: Buffer; headers: Record<string, string> } => {
  const body = Buffer.from(JSON.stringify(value))
  return { body, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } }
}

/** First contact: fetch the host's certificate (not yet trusted) so pairing can bind to it. */
export async function hello(endpoint: HostEndpoint): Promise<PinnedHost & { hostName: string }> {
  let certPem = ''
  const res = await new Promise<Response>((resolve, reject) => {
    const req = request(
      { host: endpoint.address, port: endpoint.port, path: '/hello', method: 'GET', rejectUnauthorized: false, agent: false },
      (r) => {
        const cert = (r.socket as TLSSocket).getPeerCertificate(false)
        if (cert?.raw) certPem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }))
      }
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new TeamOfflineError(endpoint.address)))
    req.on('error', (err) => reject(err instanceof TeamOfflineError ? err : new TeamOfflineError(endpoint.address)))
    req.end()
  })
  const body = json(res)
  if (body.app !== 'agency-project-vault' || !certPem) throw new Error('That address is not an Agency Project Vault host.')
  return { ...endpoint, certPem, fingerprint: fingerprintOf(certPem), hostName: String(body.hostName ?? endpoint.address) }
}

/**
 * Proves knowledge of the pairing code for the certificate we saw, and checks the host's proof
 * before trusting it. Returns a request id to poll while the host user approves.
 */
export async function pairStart(host: PinnedHost, code: string, deviceName: string): Promise<string> {
  const nonce = newNonce()
  const agent = pinnedAgent(host)
  try {
    const { body, headers } = jsonBody({ deviceName, nonce, proof: pairingProof(code, 'client', host.fingerprint, nonce) })
    const reply = json(await send(host, { path: '/pair/start', method: 'POST', agent, headers, body }))
    if (reply.hostProof !== pairingProof(code, 'host', host.fingerprint, nonce)) {
      throw new Error('The host could not prove it knows the pairing code. Check the address and try again.')
    }
    return String(reply.requestId)
  } finally {
    agent.destroy()
  }
}

export async function pairStatus(host: PinnedHost, requestId: string): Promise<{ status: string; token?: string }> {
  const agent = pinnedAgent(host)
  try {
    const { body, headers } = jsonBody({ requestId })
    const reply = json(await send(host, { path: '/pair/status', method: 'POST', agent, headers, body }))
    return { status: String(reply.status), token: typeof reply.token === 'string' ? reply.token : undefined }
  } finally {
    agent.destroy()
  }
}

/** A paired PC's connection to the team vault. Same operations as the local vault, run on the host. */
export class TeamClient {
  private readonly agent: Agent

  constructor(
    readonly host: PinnedHost & { hostName: string },
    private readonly token: string
  ) {
    this.agent = pinnedAgent(host)
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` }
  }

  async rpc(method: string, args: unknown[]): Promise<unknown> {
    const { body, headers } = jsonBody({ method, args })
    const reply = json(await send(this.host, { path: '/rpc', method: 'POST', agent: this.agent, headers: { ...headers, ...this.auth() }, body }))
    if (reply.ok !== true) throw new Error(typeof reply.error === 'string' ? reply.error : 'The host could not complete the request.')
    return reply.data
  }

  /** online: the host answered. error: why this PC cannot use it (offline, removed, certificate changed). */
  async ping(): Promise<{ online: boolean; error: string | null }> {
    try {
      json(await send(this.host, { path: '/ping', method: 'GET', agent: this.agent, headers: this.auth(), timeoutMs: 4000 }))
      return { online: true, error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The host could not be reached.'
      return { online: !(err instanceof TeamOfflineError), error: message }
    }
  }

  /** Streams a local file to the host; returns a host-side token for documents.create/update. */
  async upload(localPath: string): Promise<PickedFile> {
    const { size } = await stat(localPath)
    const path = `/upload?filename=${encodeURIComponent(basename(localPath))}`
    const reply = json(
      await send(this.host, {
        path,
        method: 'POST',
        agent: this.agent,
        headers: { ...this.auth(), 'content-type': 'application/octet-stream', 'content-length': String(size) },
        body: createReadStream(localPath),
        timeoutMs: TRANSFER_IDLE_TIMEOUT_MS
      })
    )
    return reply as unknown as PickedFile
  }

  /** Downloads a document to destPath and checks it against the host's SHA-256. */
  async download(documentId: string, destPath: string): Promise<void> {
    let expected = ''
    const hash = createHash('sha256')
    const res = await send(this.host, {
      path: `/download/${documentId}`,
      method: 'GET',
      agent: this.agent,
      headers: this.auth(),
      timeoutMs: TRANSFER_IDLE_TIMEOUT_MS,
      raw: async (r) => {
        expected = String(r.headers['x-sha256'] ?? '')
        r.on('data', (c: Buffer) => hash.update(c))
        await pipeline(r, createWriteStream(destPath))
      }
    })
    if (res.status !== 200) json(res)
    if (!expected || hash.digest('hex') !== expected) {
      await unlink(destPath).catch(() => undefined)
      throw new Error('The downloaded file did not match the host copy. Nothing was saved.')
    }
  }

  close(): void {
    this.agent.destroy()
  }
}
