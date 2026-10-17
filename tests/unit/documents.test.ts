import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/db/database'
import { DocumentService, safeFilename } from '../../src/main/services/documents'
import { ProjectService } from '../../src/main/services/projects'

let dir: string
let filesDir: string
let db: Db
let docs: DocumentService
let projectId: string

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
const source = (name: string, content: string | Buffer): string => {
  const p = join(dir, 'src', name)
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(p, content)
  return p
}
const storedFiles = (): string[] =>
  readdirSync(filesDir).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => readdirSync(join(filesDir, d)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apv-doc-'))
  filesDir = join(dir, 'files')
  mkdirSync(filesDir)
  db = openDatabase(':memory:')
  const projects = new ProjectService(db)
  docs = new DocumentService(db, filesDir, projects, undefined, 1024)
  projectId = projects.create({ name: 'Shop' }).id
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('DocumentService', () => {
  it('stores a picked file under a generated name with name, purpose and hash', async () => {
    const pick = await docs.registerPick(source('../../evil name.pdf', 'pdf-bytes'))
    const d = await docs.create({ projectId, fileToken: pick.token, metadata: { displayName: 'Contract', purpose: 'Signed client contract', tags: ['legal'] } })
    expect(d).toMatchObject({ displayName: 'Contract', purpose: 'Signed client contract', originalFilename: 'evil name.pdf', mimeType: 'application/pdf', fileSize: 9, version: 1, sha256: sha(Buffer.from('pdf-bytes')) })
    expect(storedFiles()).toHaveLength(1)
    expect(storedFiles()[0]).toMatch(/^[0-9a-f-]{36}\.bin$/)
    expect(docs.list(projectId)).toHaveLength(1)
  })

  it('requires name and purpose, and a token can only be used once', async () => {
    const pick = await docs.registerPick(source('a.txt', 'a'))
    await expect(docs.create({ projectId, fileToken: pick.token, metadata: { displayName: 'A', purpose: '' } })).rejects.toThrow(/Purpose is required/)
    await docs.create({ projectId, fileToken: pick.token, metadata: { displayName: 'A', purpose: 'p' } })
    await expect(docs.create({ projectId, fileToken: pick.token, metadata: { displayName: 'A', purpose: 'p' } })).rejects.toThrow(/expired/)
  })

  it('rejects files over the size limit and directories', async () => {
    await expect(docs.registerPick(source('big.bin', Buffer.alloc(2048)))).rejects.toThrow(/limit/)
    await expect(docs.registerPick(dir)).rejects.toThrow(/regular file/)
  })

  it('exports a byte-identical copy', async () => {
    const content = Buffer.from([0, 1, 2, 3, 250, 251])
    const pick = await docs.registerPick(source('data.zip', content))
    const d = await docs.create({ projectId, fileToken: pick.token, metadata: { displayName: 'Data', purpose: 'p' } })
    const out = join(dir, 'export.zip')
    await docs.exportTo(d.id, out)
    expect(readFileSync(out).equals(content)).toBe(true)
  })

  it('replaces the file, bumps the version and removes the old copy', async () => {
    const first = await docs.registerPick(source('v1.txt', 'one'))
    const d = await docs.create({ projectId, fileToken: first.token, metadata: { displayName: 'Spec', purpose: 'p' } })
    const second = await docs.registerPick(source('v2.txt', 'two!'))
    const updated = await docs.update({ id: d.id, revision: d.revision, metadata: { displayName: 'Spec v2', purpose: 'p' }, fileToken: second.token })
    expect(updated).toMatchObject({ displayName: 'Spec v2', version: 2, originalFilename: 'v2.txt', fileSize: 4 })
    expect(storedFiles()).toHaveLength(1)
    await expect(docs.update({ id: d.id, revision: d.revision, metadata: { displayName: 'stale', purpose: 'p' } })).rejects.toThrow(/changed since/)
  })

  it('previews images and text only', async () => {
    const png = await docs.create({ projectId, fileToken: (await docs.registerPick(source('logo.png', 'PNGDATA'))).token, metadata: { displayName: 'Logo', purpose: 'p' } })
    expect(await docs.preview(png.id)).toMatchObject({ kind: 'image', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) })
    const txt = await docs.create({ projectId, fileToken: (await docs.registerPick(source('readme.md', '# hi'))).token, metadata: { displayName: 'Readme', purpose: 'p' } })
    expect(await docs.preview(txt.id)).toEqual({ kind: 'text', text: '# hi', truncated: false })
    const svg = await docs.create({ projectId, fileToken: (await docs.registerPick(source('x.svg', '<svg onload=alert(1)>'))).token, metadata: { displayName: 'Svg', purpose: 'p' } })
    expect((await docs.preview(svg.id)).kind).toBe('none')
  })

  it('refuses to open executable types but opens others from a temp copy', async () => {
    const exe = await docs.create({ projectId, fileToken: (await docs.registerPick(source('setup.exe', 'MZ'))).token, metadata: { displayName: 'Tool', purpose: 'p' } })
    await expect(docs.prepareOpen(exe.id, join(dir, 'open'))).rejects.toThrow(/Use Export/)
    const pdf = await docs.create({ projectId, fileToken: (await docs.registerPick(source('a:b?.pdf', 'x'))).token, metadata: { displayName: 'Pdf', purpose: 'p' } })
    const opened = await docs.prepareOpen(pdf.id, join(dir, 'open'))
    expect(opened.endsWith('a_b_.pdf')).toBe(true)
    expect(readFileSync(opened, 'utf8')).toBe('x')
  })

  it('soft-deletes and keeps the file for recovery', async () => {
    const d = await docs.create({ projectId, fileToken: (await docs.registerPick(source('a.txt', 'a'))).token, metadata: { displayName: 'A', purpose: 'p' } })
    docs.remove(d.id)
    expect(docs.list(projectId)).toEqual([])
    expect(storedFiles()).toHaveLength(1)
    expect(await docs.cleanupOrphans()).toBe(0)
  })

  it('cleans up half-written uploads and unreferenced files', async () => {
    mkdirSync(join(filesDir, 'tmp'))
    writeFileSync(join(filesDir, 'tmp', 'x.part'), 'partial')
    mkdirSync(join(filesDir, 'ab'))
    writeFileSync(join(filesDir, 'ab', 'abcdef01-2345-6789-abcd-ef0123456789.bin'), 'orphan')
    expect(await docs.cleanupOrphans()).toBe(1)
    expect(existsSync(join(filesDir, 'tmp'))).toBe(false)
  })
})

describe('safeFilename', () => {
  it('strips path parts and Windows-illegal characters', () => {
    expect(safeFilename('..\\..\\x.pdf')).toBe('x.pdf')
    expect(safeFilename('a<b>c|d.txt')).toBe('a_b_c_d.txt')
    expect(safeFilename('...')).toBe('document')
  })
})
