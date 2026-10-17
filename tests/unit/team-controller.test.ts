import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KeyProtector } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'
import { readTeamConfig } from '../../src/main/team/config'
import { TeamController } from '../../src/main/team/controller'

// Reversible stand-in for DPAPI, so the test can see the token is not stored in plain text.
const xorProtector: KeyProtector = {
  name: 'safeStorage',
  protect: (key) => Buffer.from(key.map((b) => b ^ 0x5a)),
  unprotect: (blob) => Buffer.from(blob.map((b) => b ^ 0x5a))
}

interface Pc {
  dir: string
  vault: Vault
  team: TeamController
}

let root: string
const pcs: Pc[] = []

function pc(name: string): Pc {
  const dir = join(root, name)
  const vault = Vault.open(dir, xorProtector)
  const team = new TeamController({ dataDir: dir, protector: xorProtector, getVault: () => vault, hostName: name, port: 0, bind: '127.0.0.1' })
  const created = { dir, vault, team }
  pcs.push(created)
  return created
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apv-ctl-'))
})

afterEach(async () => {
  for (const p of pcs.splice(0)) {
    await p.team.close()
    p.vault.close()
  }
  rmSync(root, { recursive: true, force: true })
})

async function joinPc(host: Pc, client: Pc, deviceName: string): Promise<void> {
  const status = await host.team.status()
  if (status.role !== 'host') throw new Error('not hosting')
  const { code } = host.team.host!.newCode()
  const req = await client.team.join({ address: `127.0.0.1:${status.port}`, code, deviceName })
  expect(req.hostName).toBe('PC-A')
  expect(await client.team.joinStatus(req.requestId)).toBe('pending')
  await host.team.approve(req.requestId)
  expect(await client.team.joinStatus(req.requestId)).toBe('approved')
}

describe('TeamController (three PCs)', () => {
  it('shares one vault between a host and two joined PCs, and survives restarts', async () => {
    const a = pc('PC-A')
    await a.team.init()
    expect(a.team.role).toBe('personal')
    const hosting = await a.team.enableHost()
    expect(hosting).toMatchObject({ role: 'host', running: true, error: null })
    expect(readTeamConfig(a.dir)).toEqual({ role: 'host' })

    const b = pc('PC-B')
    const c = pc('PC-C')
    await joinPc(a, b, 'Laptop B')
    await joinPc(a, c, 'Laptop C')
    expect(a.team.host!.devices().map((d) => d.name)).toEqual(['Laptop B', 'Laptop C'])

    // B creates, C sees it, A (the host) has it locally.
    const project = (await b.team.client!.rpc('projects:create', [{ name: 'Shop', clientName: 'Acme' }])) as { id: string }
    const seenByC = (await c.team.client!.rpc('projects:list', [{}])) as { id: string }[]
    expect(seenByC.map((p) => p.id)).toEqual([project.id])
    expect(a.vault.projects.list({}).map((p) => p.id)).toEqual([project.id])

    // The device token is stored protected, and the role comes back after a restart.
    const saved = readFileSync(join(b.dir, 'team', 'config.json'), 'utf8')
    const config = readTeamConfig(b.dir)
    expect(config.role).toBe('client')
    const restartedB = new TeamController({ dataDir: b.dir, protector: xorProtector, getVault: () => b.vault, hostName: 'PC-B' })
    await restartedB.init()
    expect(restartedB.role).toBe('client')
    expect(((await restartedB.client!.rpc('projects:list', [{}])) as unknown[]).length).toBe(1)
    await restartedB.close()
    expect(saved).not.toContain((b.team.client as unknown as { token: string }).token)

    // Joined PCs cannot host, the host cannot join.
    await expect(b.team.enableHost()).rejects.toThrow(/Leave it/)
    await expect(a.team.join({ address: '127.0.0.1', code: 'AAAA-AAAA', deviceName: 'x' })).rejects.toThrow(/Stop sharing/)

    // Leaving goes back to the local vault; the host can revoke a PC.
    expect(await c.team.leave()).toEqual({ role: 'personal' })
    expect(readTeamConfig(c.dir)).toEqual({ role: 'personal' })
    const laptopB = a.team.host!.devices().find((d) => d.name === 'Laptop B')!
    await a.team.revoke(laptopB.id)
    await expect(b.team.client!.rpc('projects:list', [{}])).rejects.toThrow(/removed on the host/)
    expect(await b.team.status()).toMatchObject({ role: 'client', online: true, error: expect.stringMatching(/removed on the host/) })
  })

  it('reports an offline host and a denied request', async () => {
    const a = pc('PC-A')
    await a.team.enableHost()
    const b = pc('PC-B')
    const status = await a.team.status()
    if (status.role !== 'host') throw new Error('not hosting')
    const req = await b.team.join({ address: `127.0.0.1:${status.port}`, code: status.code!.code, deviceName: 'B' })
    await a.team.deny(req.requestId)
    expect(await b.team.joinStatus(req.requestId)).toBe('denied')
    expect(await b.team.joinStatus('unknown-request')).toBe('expired')

    await joinPc(a, b, 'B')
    await a.team.disableHost()
    expect(readTeamConfig(a.dir)).toEqual({ role: 'personal' })
    expect(await b.team.status()).toMatchObject({ role: 'client', online: false })
    await expect(b.team.client!.rpc('projects:list', [{}])).rejects.toThrow(/Team Vault offline/)
  })

  it('stays a host and explains when the port is taken', async () => {
    const a = pc('PC-A')
    await a.team.enableHost()
    const port = a.team.host!.port
    const b = pc('PC-B')
    const clash = new TeamController({ dataDir: b.dir, protector: xorProtector, getVault: () => b.vault, hostName: 'PC-B', port, bind: '127.0.0.1' })
    const status = await clash.enableHost()
    expect(status).toMatchObject({ role: 'host', running: false })
    expect(status.role === 'host' && status.error).toMatch(/already in use/)
    await clash.close()
  })
})
