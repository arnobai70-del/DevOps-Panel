import { mkdirSync, mkdtempSync, readdirSync, renameSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unprotectedKeys } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'
import { TeamController } from '../../src/main/team/controller'
import { readTeamConfig } from '../../src/main/team/config'
import { TEAM_DIR, findTeamFolders } from '../../src/main/sync/teamFolder'

interface Pc {
  dir: string
  vault: Vault
  team: TeamController
  changes: number
}

let root: string
let shared: string
const pcs: Pc[] = []
const PASS = 'correct horse battery'

function pc(name: string, searchRoots?: string[]): Pc {
  const dir = join(root, name)
  const created: Pc = { dir, vault: Vault.open(dir, unprotectedKeys), team: null as never, changes: 0 }
  created.team = new TeamController({
    dataDir: dir,
    protector: unprotectedKeys,
    getVault: () => created.vault,
    hostName: name,
    syncIntervalMs: 3_600_000,
    searchRoots,
    reopenVault: () => {
      created.vault.close()
      created.vault = Vault.open(dir, unprotectedKeys)
    },
    onRemoteChange: () => created.changes++
  })
  pcs.push(created)
  return created
}

const sync = async (...list: Pc[]): Promise<void> => {
  for (const p of list) await p.team.syncNow()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'apv-folder-'))
  shared = join(root, 'GoogleDrive')
})
afterEach(async () => {
  for (const p of pcs.splice(0)) {
    await p.team.close()
    p.vault.close()
  }
  rmSync(root, { recursive: true, force: true })
})

describe('team sync through a shared folder', () => {
  it('shares projects, credentials, documents, edits and deletes between three PCs with no server', async () => {
    const a = pc('A')
    const project = a.vault.projects.create({ name: 'Telecom' })
    a.vault.credentials.save({ projectId: project.id, serviceName: 'cPanel', username: 'admin', password: 'Folder-Canary-55' })
    const src = join(root, 'contract.txt')
    writeFileSync(src, 'signed contract')
    const pick = await a.vault.documents.registerPick(src)
    await a.vault.documents.create({ projectId: project.id, fileToken: pick.token, metadata: { displayName: 'Contract', purpose: 'legal' } })

    const status = await a.team.createFolderTeam({ folder: shared, teamName: 'Our agency', passphrase: PASS })
    expect(status).toMatchObject({ role: 'folder', teamName: 'Our agency', error: null })

    // B has its own data and its own key before joining.
    const b = pc('B')
    const own = b.vault.projects.create({ name: 'B private before joining' })
    b.vault.credentials.save({ projectId: own.id, serviceName: 'GitHub', password: 'B-Secret-77' })
    await expect(b.team.joinFolderTeam({ folder: shared, passphrase: 'wrong passphrase' })).rejects.toThrow(/Wrong team passphrase/)
    await b.team.joinFolderTeam({ folder: shared, passphrase: PASS })
    expect(readTeamConfig(b.dir)).toMatchObject({ role: 'folder', folder: shared })

    // B sees A's project and can use A's credential and document.
    expect(b.vault.projects.list().map((p) => p.name).sort()).toEqual(['B private before joining', 'Telecom'])
    const [cred] = b.vault.credentials.list(project.id)
    expect(b.vault.credentials.reveal(cred!.id, 'password')).toBe('Folder-Canary-55')
    const [doc] = b.vault.documents.list(project.id)
    const out = join(root, 'exported.txt')
    await b.vault.documents.exportTo(doc!.id, out)
    expect(readFileSync(out, 'utf8')).toBe('signed contract')
    // B's own credential was re-encrypted with the team key and still opens.
    const ownCred = b.vault.credentials.list(own.id)[0]!
    expect(b.vault.credentials.reveal(ownCred.id, 'password')).toBe('B-Secret-77')

    // C joins and gets everything; A gets B's project.
    const c = pc('C')
    await c.team.joinFolderTeam({ folder: shared, passphrase: PASS })
    await sync(a)
    for (const p of [a, c]) expect(p.vault.projects.list().map((x) => x.name).sort()).toEqual(['B private before joining', 'Telecom'])
    expect(c.vault.credentials.reveal(c.vault.credentials.list(own.id)[0]!.id, 'password')).toBe('B-Secret-77')
    expect(a.changes).toBeGreaterThan(0)

    // An edit on C reaches A and B; the later of two edits to the same project wins everywhere.
    const onC = c.vault.projects.require(project.id)
    c.vault.projects.update({ id: project.id, revision: onC.revision, input: { name: 'Telecom (C edit)' } })
    await sync(c, a, b)
    expect(a.vault.projects.require(project.id).name).toBe('Telecom (C edit)')
    const onA = a.vault.projects.require(project.id)
    a.vault.projects.update({ id: project.id, revision: onA.revision, input: { name: 'Telecom (A first)' } })
    await new Promise((r) => setTimeout(r, 5))
    const onB = b.vault.projects.require(project.id)
    b.vault.projects.update({ id: project.id, revision: onB.revision, input: { name: 'Telecom (B later)' } })
    await sync(b, a, c, b)
    for (const p of [a, b, c]) expect(p.vault.projects.require(project.id).name).toBe('Telecom (B later)')

    // A note removed on B disappears on A (soft delete syncs as a normal change).
    const note = b.vault.notes.save({ projectId: project.id, title: 'Deploy', body: 'steps' })
    await sync(b, a)
    expect(a.vault.notes.list(project.id).map((n) => n.title)).toEqual(['Deploy'])
    b.vault.notes.remove(note.id)
    await sync(b, a)
    expect(a.vault.notes.list(project.id)).toEqual([])

    // Deleting a project on A removes it, its credentials and its document file on B and C.
    await a.vault.deleteProject(project.id)
    await sync(a, b, c)
    for (const p of [b, c]) {
      expect(p.vault.projects.get(project.id)).toBeNull()
      expect(p.vault.credentials.list(project.id)).toEqual([])
    }

    // The shared folder holds only ciphertext.
    const files = readdirSync(join(shared, TEAM_DIR), { recursive: true }).map(String)
    for (const f of files.filter((n) => n.endsWith('.rec') || n.endsWith('.bin'))) {
      const body = readFileSync(join(shared, TEAM_DIR, f))
      for (const plain of ['Folder-Canary-55', 'B-Secret-77', 'signed contract', 'Telecom', 'cPanel']) {
        expect(body.includes(Buffer.from(plain))).toBe(false)
      }
    }
  })

  it('refuses to mix with LAN sharing, rejects a folder with no team, and can leave', async () => {
    const a = pc('A')
    await expect(a.team.joinFolderTeam({ folder: shared, passphrase: PASS })).rejects.toThrow(/No team vault found/)
    await expect(a.team.createFolderTeam({ folder: shared, teamName: 'T', passphrase: 'short' })).rejects.toThrow(/at least 10/)
    await a.team.createFolderTeam({ folder: shared, teamName: 'T', passphrase: PASS })
    await expect(a.team.createFolderTeam({ folder: shared, teamName: 'T', passphrase: PASS })).rejects.toThrow(/already syncs/)
    await expect(a.team.enableHost()).rejects.toThrow(/Stop folder sync first/)
    const b = pc('B')
    await expect(b.team.createFolderTeam({ folder: shared, teamName: 'T2', passphrase: PASS })).rejects.toThrow(/already has a team/)

    expect(await a.team.leaveFolder()).toEqual({ role: 'personal' })
    expect(readTeamConfig(a.dir)).toEqual({ role: 'personal' })
  })

  it('reports a missing folder instead of failing silently, and resumes after a restart', async () => {
    const a = pc('A')
    await a.team.createFolderTeam({ folder: shared, teamName: 'T', passphrase: PASS })
    a.vault.projects.create({ name: 'Before restart' })
    await a.team.close()
    const restarted = new TeamController({
      dataDir: a.dir,
      protector: unprotectedKeys,
      getVault: () => a.vault,
      hostName: 'A',
      syncIntervalMs: 3_600_000
    })
    await restarted.init()
    expect(restarted.role).toBe('folder')
    await restarted.syncNow()
    const b = pc('B')
    await b.team.joinFolderTeam({ folder: shared, passphrase: PASS })
    expect(b.vault.projects.list().map((p) => p.name)).toEqual(['Before restart'])

    rmSync(shared, { recursive: true, force: true })
    expect(await restarted.syncNow()).toMatchObject({ role: 'folder', error: expect.stringMatching(/team folder is not available/) })
    await restarted.close()
  })

  it('joins with only the passphrase by finding the team folder in Google Drive, and follows it if the drive letter changes', async () => {
    const drives = [join(root, 'G', 'My Drive'), join(root, 'H', 'My Drive')]
    const teamFolder = join(drives[0], 'Clients', 'Agency Vault')
    const other = join(drives[0], 'Other team')
    mkdirSync(teamFolder, { recursive: true })
    const a = pc('A')
    a.vault.projects.create({ name: 'Owner project' })
    await a.team.createFolderTeam({ folder: teamFolder, teamName: 'Agency', passphrase: PASS })
    const stranger = pc('S')
    await stranger.team.createFolderTeam({ folder: other, teamName: 'Other', passphrase: 'another passphrase' })
    expect((await findTeamFolders(drives)).sort()).toEqual([teamFolder, other].sort())

    const lost = pc('L', [join(root, 'nowhere')])
    await expect(lost.team.joinFolderTeam({ passphrase: PASS })).rejects.toThrow(/No team folder found/)
    const b = pc('B', drives)
    await expect(b.team.joinFolderTeam({ passphrase: 'not the passphrase' })).rejects.toThrow(/Wrong team passphrase/)
    expect(b.team.role).toBe('personal')
    expect(await b.team.joinFolderTeam({ passphrase: PASS })).toMatchObject({ role: 'folder', folder: teamFolder, teamName: 'Agency' })
    expect(b.vault.projects.list().map((p) => p.name)).toEqual(['Owner project'])

    // Google Drive comes back as H: instead of G:; B finds the same team again and keeps syncing.
    await a.team.close()
    renameSync(join(root, 'G'), join(root, 'H'))
    b.vault.projects.create({ name: 'After the move' })
    expect(await b.team.syncNow()).toMatchObject({ role: 'folder', folder: join(drives[1], 'Clients', 'Agency Vault'), error: null })
    expect(readTeamConfig(b.dir)).toMatchObject({ folder: join(drives[1], 'Clients', 'Agency Vault') })
  })
})
