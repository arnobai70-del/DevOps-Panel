import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Db } from '../db/database'
import { MAX_DOCUMENT_BYTES } from '../../shared/constants'
import { documentCreateSchema, documentUpdateSchema } from '../../shared/schemas'
import type { DocumentCreate, DocumentPreview, DocumentSummary, DocumentUpdate, PickedFile } from '../../shared/types'
import { assertUpdated, NotFoundError } from './errors'
import type { ProjectService } from './projects'

interface DocumentRow {
  id: string
  project_id: string
  display_name: string
  purpose: string
  description: string
  category: string | null
  tags_json: string
  original_filename: string
  storage_key: string
  mime_type: string | null
  file_size: number
  sha256: string
  version: number
  revision: number
  created_at: string
  updated_at: string
}

interface StoredFile {
  storageKey: string
  size: number
  sha256: string
}

const STORAGE_KEY = /^[0-9a-f]{2}\/[0-9a-f-]{36}\.bin$/
const PICK_TTL_MS = 15 * 60 * 1000
const MAX_IMAGE_PREVIEW = 15 * 1024 * 1024
const MAX_TEXT_PREVIEW = 256 * 1024

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.log': 'text/plain',
  '.ini': 'text/plain',
  '.sql': 'text/plain'
}
// SVG is deliberately not previewed: it can carry script.
const IMAGE_PREVIEW = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const TEXT_PREVIEW = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.yml', '.yaml', '.log', '.ini', '.sql'])
/** Types Windows would execute rather than open; these can be exported but never launched from the app. */
const EXECUTABLE = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp',
  '.scr', '.hta', '.cpl', '.lnk', '.pif', '.reg', '.jar', '.application', '.appref-ms', '.gadget', '.inf', '.url',
  '.sh', '.html', '.htm', '.svg', '.xhtml', '.chm', '.dll', '.sys', '.iso', '.img', '.vhd', '.vhdx', '.msc'
])

/** True for file types that must never be launched from the vault (exporting them is fine). */
export function isExecutableName(filename: string): boolean {
  return EXECUTABLE.has(extname(filename).toLowerCase())
}

export class DocumentService {
  private readonly picks = new Map<
    string,
    { path: string; filename: string; size: number; expires: number; deleteAfterUse: boolean }
  >()

  constructor(
    private readonly db: Db,
    private readonly filesDir: string,
    private readonly projects: ProjectService,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly maxBytes = MAX_DOCUMENT_BYTES
  ) {}

  /**
   * Remembers a file the user chose in the native picker and hands back an opaque token.
   * The renderer can only refer to files through these tokens, never by path.
   */
  async registerPick(path: string, opts: { filename?: string; deleteAfterUse?: boolean } = {}): Promise<PickedFile> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('Please choose a regular file.')
    this.checkSize(info.size)
    const token = randomUUID()
    const now = Date.now()
    for (const [key, pick] of this.picks) {
      if (pick.expires >= now) continue
      this.picks.delete(key)
      if (pick.deleteAfterUse) await unlink(pick.path).catch(() => undefined)
    }
    const filename = opts.filename ? safeFilename(opts.filename) : basename(path)
    this.picks.set(token, {
      path,
      filename,
      size: info.size,
      expires: now + PICK_TTL_MS,
      deleteAfterUse: opts.deleteAfterUse ?? false
    })
    return { token, filename, size: info.size }
  }

  list(projectId: string): DocumentSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM documents WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
      .all(projectId) as DocumentRow[]
    return rows.map(toSummary)
  }

  get(id: string): DocumentSummary {
    return toSummary(this.requireRow(id))
  }

  async create(raw: DocumentCreate): Promise<DocumentSummary> {
    const { projectId, fileToken, metadata } = documentCreateSchema.parse(raw)
    this.projects.require(projectId)
    const pick = this.takePick(fileToken)
    const stored = await this.storePick(pick)
    const id = randomUUID()
    const timestamp = this.now()
    try {
      this.db
        .prepare(
          `INSERT INTO documents (
            id, project_id, display_name, purpose, description, category, tags_json, original_filename,
            storage_key, mime_type, file_size, sha256, created_at, updated_at
          ) VALUES (
            @id, @projectId, @displayName, @purpose, @description, @category, @tags, @filename,
            @storageKey, @mimeType, @size, @sha256, @timestamp, @timestamp
          )`
        )
        .run({
          ...metadata,
          ...stored,
          id,
          projectId,
          tags: JSON.stringify(metadata.tags),
          filename: pick.filename,
          mimeType: mimeOf(pick.filename),
          timestamp
        })
    } catch (err) {
      await this.discard(stored.storageKey)
      throw err
    }
    return toSummary(this.row(id)!)
  }

  async update(raw: DocumentUpdate): Promise<DocumentSummary> {
    const { id, revision, metadata, fileToken } = documentUpdateSchema.parse(raw)
    const existing = this.row(id)
    if (!existing) throw new NotFoundError('document')
    const pick = fileToken ? this.takePick(fileToken) : null
    const stored = pick ? await this.storePick(pick) : null
    try {
      const result = this.db
        .prepare(
          `UPDATE documents SET
            display_name = @displayName, purpose = @purpose, description = @description, category = @category,
            tags_json = @tags,
            original_filename = COALESCE(@filename, original_filename),
            storage_key = COALESCE(@storageKey, storage_key),
            mime_type = CASE WHEN @storageKey IS NULL THEN mime_type ELSE @mimeType END,
            file_size = COALESCE(@size, file_size),
            sha256 = COALESCE(@sha256, sha256),
            version = version + CASE WHEN @storageKey IS NULL THEN 0 ELSE 1 END,
            revision = revision + 1, updated_at = @timestamp
          WHERE id = @id AND revision = @revision AND deleted_at IS NULL`
        )
        .run({
          ...metadata,
          id,
          revision,
          tags: JSON.stringify(metadata.tags),
          filename: pick?.filename ?? null,
          storageKey: stored?.storageKey ?? null,
          mimeType: pick ? mimeOf(pick.filename) : null,
          size: stored?.size ?? null,
          sha256: stored?.sha256 ?? null,
          timestamp: this.now()
        })
      assertUpdated(result.changes, true, 'document')
    } catch (err) {
      if (stored) await this.discard(stored.storageKey)
      throw err
    }
    if (stored) await this.discard(existing.storage_key)
    return toSummary(this.row(id)!)
  }

  /** Soft delete. The file stays on disk so the document can be recovered. */
  remove(id: string): void {
    const result = this.db
      .prepare('UPDATE documents SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(this.now(), id)
    if (result.changes === 0) throw new NotFoundError('document')
  }

  async preview(id: string): Promise<DocumentPreview> {
    const row = this.requireRow(id)
    const ext = extname(row.original_filename).toLowerCase()
    if (IMAGE_PREVIEW.has(ext)) {
      if (row.file_size > MAX_IMAGE_PREVIEW) return { kind: 'none', reason: 'Image is too large to preview.' }
      const data = await readFile(this.pathOf(row.storage_key))
      return { kind: 'image', dataUrl: `data:${MIME[ext]};base64,${data.toString('base64')}` }
    }
    if (TEXT_PREVIEW.has(ext)) {
      const data = await readFile(this.pathOf(row.storage_key))
      const truncated = data.length > MAX_TEXT_PREVIEW
      return { kind: 'text', text: data.subarray(0, MAX_TEXT_PREVIEW).toString('utf8'), truncated }
    }
    return { kind: 'none', reason: 'No preview for this file type. Export it or open it with its default app.' }
  }

  /** Copies the stored file to destPath and checks the copy against the recorded SHA-256. */
  async exportTo(id: string, destPath: string): Promise<void> {
    const row = this.requireRow(id)
    await copyFile(this.pathOf(row.storage_key), destPath)
    if ((await sha256Of(destPath)) !== row.sha256) {
      await unlink(destPath).catch(() => undefined)
      throw new Error('The exported copy did not match the stored file. Nothing was exported.')
    }
  }

  /** Copies the file into tempDir under its original name so the OS can open it; refuses executable types. */
  async prepareOpen(id: string, tempDir: string): Promise<string> {
    const row = this.requireRow(id)
    if (isExecutableName(row.original_filename)) {
      throw new Error(executableRefusal(row.original_filename))
    }
    const dir = join(tempDir, randomUUID())
    await mkdir(dir, { recursive: true })
    const target = join(dir, safeFilename(row.original_filename))
    await this.exportTo(id, target)
    return target
  }

  /** Deletes half-written uploads and stored files no document row refers to (e.g. after a crash). */
  async cleanupOrphans(): Promise<number> {
    await rm(join(this.filesDir, 'tmp'), { recursive: true, force: true })
    const known = new Set(
      (this.db.prepare('SELECT storage_key FROM documents').all() as { storage_key: string }[]).map((r) => r.storage_key)
    )
    let removed = 0
    for (const shard of await readdir(this.filesDir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue
      for (const name of await readdir(join(this.filesDir, shard))) {
        const key = `${shard}/${name}`
        if (STORAGE_KEY.test(key) && !known.has(key)) {
          await unlink(join(this.filesDir, key))
          removed++
        }
      }
    }
    return removed
  }

  private checkSize(size: number): void {
    if (size > this.maxBytes) {
      throw new Error(`File is larger than the ${Math.round(this.maxBytes / 1024 / 1024)} MB limit.`)
    }
  }

  /** Opens the stored file for streaming, e.g. to a team client. */
  openRead(id: string): { summary: DocumentSummary; stream: NodeJS.ReadableStream } {
    const row = this.requireRow(id)
    return { summary: toSummary(row), stream: createReadStream(this.pathOf(row.storage_key)) }
  }

  private async storePick(pick: { path: string; deleteAfterUse: boolean }): Promise<StoredFile> {
    try {
      return await this.store(pick.path)
    } finally {
      if (pick.deleteAfterUse) await unlink(pick.path).catch(() => undefined)
    }
  }

  private takePick(token: string): { path: string; filename: string; deleteAfterUse: boolean } {
    const pick = this.picks.get(token)
    this.picks.delete(token)
    if (!pick || pick.expires < Date.now()) throw new Error('The chosen file has expired. Please choose it again.')
    return pick
  }

  /** Streams the source into a temp file while hashing, then renames it into place. */
  private async store(sourcePath: string): Promise<StoredFile> {
    const id = randomUUID()
    const storageKey = `${id.slice(0, 2)}/${id}.bin`
    const tmpDir = join(this.filesDir, 'tmp')
    const tmp = join(tmpDir, `${id}.part`)
    await mkdir(tmpDir, { recursive: true })
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        size += chunk.length
        if (size > this.maxBytes) return done(new Error('File is larger than the allowed limit.'))
        hash.update(chunk)
        done(null, chunk)
      }
    })
    try {
      await pipeline(createReadStream(sourcePath), meter, createWriteStream(tmp, { flags: 'wx' }))
      await mkdir(join(this.filesDir, storageKey.slice(0, 2)), { recursive: true })
      await rename(tmp, this.pathOf(storageKey))
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
    return { storageKey, size, sha256: hash.digest('hex') }
  }

  /** Deletes stored files whose document rows are already gone (e.g. after a project was deleted). */
  async discardFiles(storageKeys: string[]): Promise<void> {
    for (const key of storageKeys) await this.discard(key)
  }

  private async discard(storageKey: string): Promise<void> {
    await unlink(this.pathOf(storageKey)).catch(() => undefined)
  }

  private pathOf(storageKey: string): string {
    if (!STORAGE_KEY.test(storageKey)) throw new Error('Invalid storage key')
    return join(this.filesDir, storageKey)
  }

  private row(id: string): DocumentRow | null {
    return (
      (this.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(id) as
        | DocumentRow
        | undefined) ?? null
    )
  }

  private requireRow(id: string): DocumentRow {
    const row = this.row(id)
    if (!row) throw new NotFoundError('document')
    return row
  }
}

function toSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    displayName: row.display_name,
    purpose: row.purpose,
    description: row.description,
    category: row.category as DocumentSummary['category'],
    tags: JSON.parse(row.tags_json) as string[],
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    sha256: row.sha256,
    version: row.version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mimeOf(filename: string): string | null {
  return MIME[extname(filename).toLowerCase()] ?? null
}

export function executableRefusal(filename: string): string {
  return `For safety, ${extname(filename).toLowerCase()} files are not opened from the vault. Use Export instead.`
}

export function safeFilename(name: string): string {
  const cleaned = (name.split(/[\\/]/).pop() ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150)
  return cleaned || 'document'
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}
