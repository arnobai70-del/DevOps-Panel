import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unprotectedKeys } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'
import { hello, pairStart, pairStatus, TeamClient, TeamOfflineError, type PinnedHost } from '../../src/main/team/client'
import { TeamHost } from '../../src/main/team/host'
import { isPrivateAddress, normalizeCode, parseHostAddress } from '../../src/main/team/protocol'

let root: string
let vault: Vault
let host: TeamHost
const clients: TeamClient[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'apv-team-'))
  vault = Vault.open(join(root, 'host'), unprotectedKeys)
  host = new TeamHost({ getVault: () => vault, dataDir: join(root, 'host'), hostName: 'PC-A', port: 0, bind: '127.0.0.1' })
  await host.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await host.stop()
  vault.close()
  rmSync(root, { recursive: true, force: true })
})

const endpoint = () => ({ address: '127.0.0.1', port: host.port })

async function pairPc(name: string): Promise<TeamClient> {
  const { code } = host.newCode()
  const pinned = await hello(endpoint())
  const requestId = await pairStart(pinned, code, name)
  expect(await pairStatus(pinned, requestId)).toEqual({ status: 'pending' })
  expect(host.pendingRequests().map((p) => p.deviceName)).toEqual([name])
  host.approve(requestId)
  const approved = await pairStatus(pinned, requestId)
  expect(approved.status).toBe('approved')
  expect(await pairStatus(pinned, requestId)).toEqual({ status: 'unknown' })
  const client = new TeamClient(pinned, approved.token!)
  clients.push(client)
  return client
}

describe('team host and clients', () => {
  it('pairs two PCs that then see and edit the same data', async () => {
    const pcB = await pairPc('PC-B')
    const pcC = await pairPc('PC-C')
    expect(host.devices().map((d) => d.name)).toEqual(['PC-B', 'PC-C'])

    const project = (await pcB.rpc('projects:create', [{ name: 'Shared project' }])) as { id: string }
    const fromC = (await pcC.rpc('projects:list', [{}])) as { name: string }[]
    expect(fromC.map((p) => p.name)).toEqual(['Shared project'])
    expect(vault.projects.list().map((p) => p.name)).toEqual(['Shared project'])

    const cred = (await pcC.rpc('credentials:save', [{ projectId: project.id, serviceName: 'Hosting', password: 'TeamSecret-1' }])) as { id: string }
    expect(await pcB.rpc('credentials:reveal', [cred.id, 'password'])).toBe('TeamSecret-1')
  })

  it('shows a conflict instead of losing a simultaneous edit', async () => {
    const pcB = await pairPc('PC-B')
    const pcC = await pairPc('PC-C')
    const p = (await pcB.rpc('projects:create', [{ name: 'Original' }])) as { id: string; revision: number }
    await pcB.rpc('projects:update', [{ id: p.id, revision: p.revision, input: { name: 'B edit' } }])
    await expect(pcC.rpc('projects:update', [{ id: p.id, revision: p.revision, input: { name: 'C edit' } }])).rejects.toThrow(/changed since you opened it/)
    expect(vault.projects.get(p.id)!.name).toBe('B edit')
  })

  it('uploads and downloads documents with hash checks', async () => {
    const pcB = await pairPc('PC-B')
    const p = (await pcB.rpc('projects:create', [{ name: 'Docs' }])) as { id: string }
    const local = join(root, 'spec v1.txt')
    writeFileSync(local, 'requirements from PC-B')
    const picked = await pcB.upload(local)
    expect(picked).toMatchObject({ filename: 'spec v1.txt', size: 22 })
    const doc = (await pcB.rpc('documents:create', [{ projectId: p.id, fileToken: picked.token, metadata: { displayName: 'Spec', purpose: 'Scope' } }])) as { id: string }
    const out = join(root, 'downloaded.txt')
    await pcB.download(doc.id, out)
    expect(readFileSync(out, 'utf8')).toBe('requirements from PC-B')
    expect(readdirSync(join(root, 'host', 'team', 'uploads'))).toEqual([])
  })

  it('rejects unpaired and revoked PCs and unknown operations', async () => {
    const pcB = await pairPc('PC-B')
    const pinned = await hello(endpoint())
    const stranger = new TeamClient(pinned, 'not-a-real-token')
    clients.push(stranger)
    await expect(stranger.rpc('projects:list', [{}])).rejects.toThrow(/not paired/)
    await expect(pcB.rpc('backups:create', ['x'])).rejects.toThrow(/Unknown operation/)
    await expect(pcB.rpc('constructor', [])).rejects.toThrow(/Unknown operation/)

    host.revoke(host.devices()[0]!.id)
    await expect(pcB.rpc('projects:list', [{}])).rejects.toThrow(/not paired/)
    expect(host.devices()).toEqual([])
  })

  it('locks the code after repeated wrong guesses and never pairs with a wrong code', async () => {
    const { code } = host.newCode()
    const pinned = await hello(endpoint())
    for (let i = 0; i < 5; i++) await expect(pairStart(pinned, 'AAAA-AAAA', 'Guesser')).rejects.toThrow(/Wrong pairing code|Too many/)
    await expect(pairStart(pinned, code, 'Guesser')).rejects.toThrow(/No pairing code|Too many/)
    expect(host.pendingRequests()).toEqual([])
  })

  it('refuses a host whose certificate does not match the pinned one', async () => {
    const pcB = await pairPc('PC-B')
    const other = new TeamHost({ getVault: () => vault, dataDir: join(root, 'impostor'), hostName: 'EVIL', port: 0, bind: '127.0.0.1' })
    await other.start()
    try {
      const impostor: PinnedHost & { hostName: string } = { ...pcB.host, port: other.port }
      const client = new TeamClient(impostor, 'whatever')
      clients.push(client)
      await expect(client.rpc('projects:list', [{}])).rejects.toThrow(/different certificate/)
      // A man in the middle relaying pairing with its own certificate cannot pass the host's proof check.
      const { code } = host.newCode()
      const mitm = await hello({ address: '127.0.0.1', port: other.port })
      await expect(pairStart({ ...mitm, port: host.port }, code, 'MITM')).rejects.toThrow(/different certificate/)
    } finally {
      await other.stop()
    }
  })

  it('reports the host as offline when it is not running', async () => {
    const pcB = await pairPc('PC-B')
    await host.stop()
    expect(await pcB.ping()).toMatchObject({ online: false, error: expect.stringMatching(/Team Vault offline/) })
    await expect(pcB.rpc('projects:list', [{}])).rejects.toThrow(TeamOfflineError)
    await host.start()
  })
})

describe('protocol helpers', () => {
  it('accepts only private network peers', () => {
    for (const ok of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.20', '::ffff:192.168.0.5', '::1', 'fe80::1', 'fd12:3456::1', '169.254.10.10']) {
      expect(isPrivateAddress(ok)).toBe(true)
    }
    for (const bad of ['8.8.8.8', '172.32.0.1', '203.0.113.5', '::ffff:1.1.1.1', '2001:db8::1', undefined]) {
      expect(isPrivateAddress(bad)).toBe(false)
    }
  })

  it('normalizes codes and parses host addresses', () => {
    expect(normalizeCode('abcd-ef0l')).toBe('ABCDEF01')
    expect(parseHostAddress(' 192.168.1.20 ')).toEqual({ address: '192.168.1.20', port: 47321 })
    expect(parseHostAddress('192.168.1.20:5000')).toEqual({ address: '192.168.1.20', port: 5000 })
    expect(() => parseHostAddress('http://x/y')).toThrow()
  })
})
