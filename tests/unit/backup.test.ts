import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackupError, createBackup, inspectStaged, lastBackupAt, readBackup, swapInStaged } from '../../src/main/services/backup'
import { unprotectedKeys, type KeyProtector } from '../../src/main/services/encryption'
import { Vault } from '../../src/main/services/vault'

const KDF = { N: 2 ** 10, r: 8, p: 1 }
const PASS = 'correct horse battery'

// A different "machine": the key is wrapped differently, like DPAPI on another PC.
const otherPc: KeyProtector = {
  name: 'safeStorage',
  protect: (k) => Buffer.from(k.map((b) => b ^ 0x5c)),
  unprotect: (k) => Buffer.from(k.map((b) => b ^ 0x5c))
}

let root: string
let pcA: string
let vault: Vault
let projectId: string
let credentialId: string
let documentId: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'apv-bak-'))
  pcA = join(root, 'pcA')
  vault = Vault.open(pcA, unprotectedKeys)
  projectId = vault.projects.create({ name: 'New Singapur Telecom', techStack: ['Laravel'] }).id
  credentialId = vault.credentials.save({ projectId, serviceName: 'WP admin', username: 'admin', password: 'BackupCanary-777' }).id
  const src = join(root, 'contract.pdf')
  writeFileSync(src, Buffer.from('%PDF-1.7 contract body'))
  const pick = await vault.documents.registerPick(src)
  documentId = (await vault.documents.create({ projectId, fileToken: pick.token, metadata: { displayName: 'Contract', purpose: 'Signed' } })).id
  vault.notes.save({ projectId, title: 'Deploy', body: 'steps' })
  vault.links.save({ projectId, label: 'Staging', url: 'https://staging.example.com' })
})

afterEach(() => {
  try {
    vault.close()
  } catch {
    // already closed by the test
  }
  rmSync(root, { recursive: true, force: true })
})

const backup = (dest: string, passphrase = PASS) =>
  createBackup({
    db: vault.database,
    dataDir: pcA,
    encryptor: vault.encryptor,
    destPath: dest,
    passphrase,
    appVersion: '0.1.0',
    kdf: KDF
  })

describe('backup and restore', () => {
  it('round-trips everything to a clean PC with a different key protector', async () => {
    const file = join(root, 'out.apv')
    const result = await backup(file)
    expect(result.counts).toEqual({ projects: 1, credentials: 1, documents: 1, notes: 1, links: 1 })
    expect(lastBackupAt(vault.database)).toBe(result.createdAt)
    expect(readFileSync(file).includes(Buffer.from('BackupCanary-777'))).toBe(false)
    expect(readdirSync(join(pcA, 'backups'))).toEqual([])

    const pcD = join(root, 'pcD')
    mkdirSync(pcD)
    const staged = await readBackup(file, PASS, join(pcD, '.restore'))
    expect(inspectStaged(staged)).toEqual(result.counts)
    swapInStaged(pcD, staged, otherPc)

    const restored = Vault.open(pcD, otherPc)
    try {
      expect(restored.projects.list().map((p) => p.name)).toEqual(['New Singapur Telecom'])
      expect(restored.credentials.reveal(credentialId, 'password')).toBe('BackupCanary-777')
      expect(restored.encryptor.protection).toBe('safeStorage')
      const out = join(root, 'exported.pdf')
      await restored.documents.exportTo(documentId, out)
      expect(readFileSync(out, 'utf8')).toBe('%PDF-1.7 contract body')
      expect(restored.notes.list(projectId)).toHaveLength(1)
      expect(lastBackupAt(restored.database)).toBe(result.createdAt)
    } finally {
      restored.close()
    }
  })

  it('refuses short passphrases', async () => {
    await expect(backup(join(root, 'x.apv'), 'short')).rejects.toThrow(/at least 10/)
    expect(existsSync(join(root, 'x.apv'))).toBe(false)
  })

  it('rejects a wrong passphrase without creating anything', async () => {
    const file = join(root, 'out.apv')
    await backup(file)
    const staging = join(root, 'stage')
    await expect(readBackup(file, 'wrong passphrase!!', staging)).rejects.toThrow(/Wrong passphrase/)
    expect(existsSync(staging)).toBe(false)
  })

  it('detects a flipped byte, truncation and non-backup files', async () => {
    const file = join(root, 'out.apv')
    await backup(file)
    const bytes = readFileSync(file)

    const flipped = Buffer.from(bytes)
    flipped[flipped.length - 40]! ^= 0x01
    writeFileSync(join(root, 'flipped.apv'), flipped)
    await expect(readBackup(join(root, 'flipped.apv'), PASS, join(root, 's1'))).rejects.toThrow(BackupError)
    expect(existsSync(join(root, 's1'))).toBe(false)

    writeFileSync(join(root, 'cut.apv'), bytes.subarray(0, bytes.length - 100))
    await expect(readBackup(join(root, 'cut.apv'), PASS, join(root, 's2'))).rejects.toThrow(/damaged|incomplete/)

    writeFileSync(join(root, 'notes.apv'), 'hello world, not a backup')
    await expect(readBackup(join(root, 'notes.apv'), PASS, join(root, 's3'))).rejects.toThrow(/not an Agency Project Vault backup/)
  })

  it('moves the current vault to a safety copy when restoring over it', async () => {
    const file = join(root, 'out.apv')
    await backup(file)
    vault.projects.create({ name: 'Added after backup' })
    const staged = await readBackup(file, PASS, join(pcA, '.restore'))
    vault.close()
    const safety = swapInStaged(pcA, staged, unprotectedKeys)
    expect(readdirSync(safety).sort()).toEqual(expect.arrayContaining(['files', 'vault.key', 'vault.sqlite']))

    vault = Vault.open(pcA, unprotectedKeys)
    expect(vault.projects.list().map((p) => p.name)).toEqual(['New Singapur Telecom'])
    const before = Vault.open(safety, unprotectedKeys)
    try {
      expect(before.projects.list().map((p) => p.name).sort()).toEqual(['Added after backup', 'New Singapur Telecom'])
    } finally {
      before.close()
    }
  })
})
