import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { unprotectedKeys } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'

let dir: string
let vault: Vault

const storedFiles = (): string[] => {
  const files = join(dir, 'vault', 'files')
  return readdirSync(files)
    .filter((d) => /^[0-9a-f]{2}$/.test(d))
    .flatMap((d) => readdirSync(join(files, d)))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apv-vault-'))
  vault = Vault.open(join(dir, 'vault'), unprotectedKeys)
})
afterEach(() => {
  vault.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Vault.deleteProject', () => {
  it('removes the project, its credentials, documents, notes, links and stored files, and nothing else', async () => {
    const doomed = vault.projects.create({ name: 'Old site' })
    const kept = vault.projects.create({ name: 'Keep me' })
    for (const p of [doomed, kept]) {
      vault.credentials.save({ projectId: p.id, serviceName: 'cPanel', password: 'secret' })
      vault.notes.save({ projectId: p.id, title: 'n', body: 'b' })
      vault.links.save({ projectId: p.id, label: 'Staging', url: 'https://staging.example.com', purpose: 'QA' })
      const src = join(dir, `${p.name}.txt`)
      writeFileSync(src, p.name)
      const pick = await vault.documents.registerPick(src)
      await vault.documents.create({ projectId: p.id, fileToken: pick.token, metadata: { displayName: 'Doc', purpose: 'test' } })
    }
    expect(storedFiles()).toHaveLength(2)

    await vault.deleteProject(doomed.id)

    expect(vault.projects.get(doomed.id)).toBeNull()
    expect(vault.projects.list({ includeArchived: true }).map((p) => p.name)).toEqual(['Keep me'])
    expect(vault.credentials.list(doomed.id)).toEqual([])
    for (const table of ['credentials', 'documents', 'notes', 'links']) {
      const rows = vault.database.prepare(`SELECT project_id FROM ${table}`).all() as { project_id: string }[]
      expect(rows.map((r) => r.project_id)).toEqual([kept.id])
    }
    expect(storedFiles()).toHaveLength(1)
    expect(vault.documents.list(kept.id)).toHaveLength(1)
    await expect(vault.deleteProject(doomed.id)).rejects.toThrow(/not found/)
  })
})
