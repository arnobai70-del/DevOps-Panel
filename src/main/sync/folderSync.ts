import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Db } from '../db/database'
import { teamDir } from './teamFolder'

/**
 * Serverless team sync through a shared folder (Google Drive, OneDrive, Dropbox, a network share).
 *
 * Every PC keeps its own SQLite vault. Each PC mirrors every row it changed as one encrypted file
 * of its own, records/<table>/<id>/<device>.rec, holding the whole row plus a stamp (the edit time,
 * kept above every stamp seen, in ms). PCs never overwrite each other's files, so the cloud client
 * never has to merge anything. A sync round first writes rows that changed here, then reads files
 * that changed in the folder and applies any whose stamp is newer than what this PC has: the
 * latest edit wins per row. Hard deletes travel as tombstone records. Document files are copied once,
 * encrypted, to files/<uuid>.bin. The folder only ever sees ciphertext; the key is the team key.
 */

/** Synced tables in dependency order: parents first so foreign keys hold while applying. */
export const SYNCED_TABLES = ['projects', 'credentials', 'documents', 'notes', 'links'] as const
type Table = (typeof SYNCED_TABLES)[number]
const CHILD_TABLES: Table[] = ['credentials', 'documents', 'notes', 'links']

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEVICE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.rec$/
const STORAGE_KEY = /^[0-9a-f]{2}\/[0-9a-f-]{36}\.bin$/
const DELETED = 'deleted'

type Row = Record<string, unknown>
interface SyncRecord {
  v: 1
  table: Table
  id: string
  stamp: number
  device: string
  deleted: boolean
  row: Row | null
}
interface StateRow {
  hash: string
  stamp: number
  device: string
}

export interface SyncResult {
  exported: number
  imported: number
  /** Records that could not be applied yet (e.g. a document whose file has not arrived). */
  pending: number
}

export interface FolderSyncOptions {
  folder: string
  teamKey: Buffer
  deviceId: string
  db: () => Db
  /** Local document store (the vault's files/ directory). */
  filesDir: () => string
  now?: () => number
}

// Rows are JSON in the records; BLOB columns (credential ciphertext) are wrapped so they survive.
const encodeValue = (v: unknown): unknown => (Buffer.isBuffer(v) ? { $b: v.toString('base64') } : v)
const decodeValue = (v: unknown): unknown =>
  v && typeof v === 'object' && typeof (v as { $b?: unknown }).$b === 'string' ? Buffer.from((v as { $b: string }).$b, 'base64') : v

function canonical(row: Row): string {
  return JSON.stringify(Object.fromEntries(Object.keys(row).sort().map((k) => [k, encodeValue(row[k])])))
}
const hashRow = (row: Row): string => createHash('sha256').update(canonical(row)).digest('hex')

export class FolderSync {
  private readonly recordKey: Buffer
  private readonly fileKey: Buffer
  private readonly seen = new Map<string, string>()
  private clock = 0
  private running: Promise<SyncResult> | null = null

  constructor(private readonly opts: FolderSyncOptions) {
    const derive = (info: string): Buffer => Buffer.from(hkdfSync('sha256', opts.teamKey, 'agency-project-vault', info, 32))
    this.recordKey = derive('sync-records-v1')
    this.fileKey = derive('sync-files-v1')
  }

  private get root(): string {
    return teamDir(this.opts.folder)
  }

  /** Runs one round; concurrent callers share the round in progress. */
  sync(): Promise<SyncResult> {
    if (!this.running) {
      this.running = this.round().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  private async round(): Promise<SyncResult> {
    if (!existsSync(join(this.root, 'team.json'))) {
      throw new Error('The team folder is not available. Check that Google Drive / OneDrive is running and the folder still exists.')
    }
    const db = this.opts.db()
    this.clock = Math.max(this.clock, this.maxStamp(db))
    const exported = await this.exportChanges(db)
    const { imported, pending } = await this.importChanges(db)
    return { exported, imported, pending }
  }

  /**
   * Next stamp: the time of the edit (or now), but always above every stamp this PC has seen,
   * so the most recent edit wins and a PC with a slow clock still moves forward.
   */
  private tick(editedAt?: unknown): number {
    const now = this.opts.now?.() ?? Date.now()
    const edited = typeof editedAt === 'string' ? Date.parse(editedAt) : NaN
    const at = Number.isFinite(edited) && edited <= now ? edited : now
    this.clock = Math.max(this.clock + 1, at)
    return this.clock
  }

  private maxStamp(db: Db): number {
    return (db.prepare('SELECT MAX(stamp) AS m FROM sync_state').get() as { m: number | null }).m ?? 0
  }

  private state(db: Db, table: Table, id: string): StateRow | undefined {
    return db.prepare('SELECT hash, stamp, device FROM sync_state WHERE tbl = ? AND id = ?').get(table, id) as StateRow | undefined
  }

  private setState(db: Db, table: Table, id: string, s: StateRow): void {
    db.prepare(
      `INSERT INTO sync_state (tbl, id, hash, stamp, device) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tbl, id) DO UPDATE SET hash = excluded.hash, stamp = excluded.stamp, device = excluded.device`
    ).run(table, id, s.hash, s.stamp, s.device)
  }

  // ---- export: local changes -> folder ----

  private async exportChanges(db: Db): Promise<number> {
    let written = 0
    for (const table of SYNCED_TABLES) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all() as Row[]
      const present = new Set<string>()
      for (const row of rows) {
        const id = String(row.id)
        present.add(id)
        const hash = hashRow(row)
        if (this.state(db, table, id)?.hash === hash) continue
        if (table === 'documents') await this.uploadFile(String(row.storage_key))
        const stamp = this.tick(row.updated_at)
        await this.writeRecord({ v: 1, table, id, stamp, device: this.opts.deviceId, deleted: false, row })
        this.setState(db, table, id, { hash, stamp, device: this.opts.deviceId })
        written++
      }
      // Rows that existed and are gone locally were hard-deleted here: publish a tombstone.
      const known = db.prepare('SELECT id FROM sync_state WHERE tbl = ? AND hash != ?').all(table, DELETED) as { id: string }[]
      for (const { id } of known) {
        if (present.has(id)) continue
        const stamp = this.tick()
        await this.writeRecord({ v: 1, table, id, stamp, device: this.opts.deviceId, deleted: true, row: null })
        this.setState(db, table, id, { hash: DELETED, stamp, device: this.opts.deviceId })
        written++
      }
    }
    return written
  }

  private async writeRecord(record: SyncRecord): Promise<void> {
    const path = join(this.root, 'records', record.table, record.id, `${record.device}.rec`)
    await this.atomicWrite(path, this.seal(this.recordKey, Buffer.from(JSON.stringify({ ...record, row: record.row && JSON.parse(canonical(record.row)) })), `${record.table}:${record.id}`))
    const info = await stat(path)
    this.seen.set(path, `${info.mtimeMs}:${info.size}`)
  }

  private async uploadFile(storageKey: string): Promise<void> {
    if (!STORAGE_KEY.test(storageKey)) return
    const target = join(this.root, 'files', basename(storageKey))
    if (existsSync(target)) return
    const local = join(this.opts.filesDir(), storageKey)
    if (!existsSync(local)) return
    await this.atomicWrite(target, this.seal(this.fileKey, await readFile(local), `file:${storageKey}`))
  }

  // ---- import: folder -> local ----

  private async importChanges(db: Db): Promise<{ imported: number; pending: number }> {
    let imported = 0
    let pending = 0
    for (const table of SYNCED_TABLES) {
      const tableDir = join(this.root, 'records', table)
      for (const id of (await readdir(tableDir).catch(() => [] as string[])).sort()) {
        if (!ID.test(id)) continue
        for (const name of await readdir(join(tableDir, id)).catch(() => [] as string[])) {
          const device = name.match(DEVICE_FILE)?.[1]
          if (!device || device === this.opts.deviceId) continue
          const path = join(tableDir, id, name)
          const info = await stat(path).catch(() => null)
          if (!info) continue
          const signature = `${info.mtimeMs}:${info.size}`
          if (this.seen.get(path) === signature) continue
          const record = await this.readRecord(path, table, id, device)
          if (!record) {
            this.seen.set(path, signature)
            continue
          }
          const outcome = await this.apply(db, record)
          if (outcome === 'pending') {
            pending++
            continue // try again next round
          }
          this.seen.set(path, signature)
          if (outcome === 'applied') imported++
        }
      }
    }
    return { imported, pending }
  }

  private async readRecord(path: string, table: Table, id: string, device: string): Promise<SyncRecord | null> {
    try {
      const record = JSON.parse(this.open(this.recordKey, await readFile(path), `${table}:${id}`).toString('utf8')) as SyncRecord
      if (record.v !== 1 || record.table !== table || record.id !== id || record.device !== device || typeof record.stamp !== 'number') {
        return null
      }
      return record
    } catch {
      // Half-synced, corrupted or written with another team key: ignore it.
      return null
    }
  }

  private async apply(db: Db, record: SyncRecord): Promise<'applied' | 'skipped' | 'pending'> {
    const local = this.state(db, record.table, record.id)
    this.clock = Math.max(this.clock, record.stamp)
    if (local && (record.stamp < local.stamp || (record.stamp === local.stamp && record.device <= local.device))) return 'skipped'
    const current = db.prepare(`SELECT * FROM ${record.table} WHERE id = ?`).get(record.id) as Row | undefined
    // A local edit not yet exported (made during this round) wins this round; it is exported next.
    if (local && current && local.hash !== hashRow(current)) return 'pending'

    if (record.deleted) {
      if (record.table === 'projects') this.deleteProjectLocally(db, record.id, record.stamp, record.device)
      else db.prepare(`DELETE FROM ${record.table} WHERE id = ?`).run(record.id)
      this.setState(db, record.table, record.id, { hash: DELETED, stamp: record.stamp, device: record.device })
      return 'applied'
    }

    const row = Object.fromEntries(Object.entries(record.row ?? {}).map(([k, v]) => [k, decodeValue(v)])) as Row
    if (record.table === 'documents' && !(await this.downloadFile(row))) return 'pending'
    try {
      this.upsert(db, record.table, row)
    } catch {
      return 'pending' // e.g. its project has not arrived yet
    }
    const stored = db.prepare(`SELECT * FROM ${record.table} WHERE id = ?`).get(record.id) as Row
    this.setState(db, record.table, record.id, { hash: hashRow(stored), stamp: record.stamp, device: record.device })
    return 'applied'
  }

  private upsert(db: Db, table: Table, row: Row): void {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name)
      .filter((c) => c in row)
    if (!columns.includes('id')) throw new Error('Record without id')
    const updates = columns.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`)
    db.prepare(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((c) => `@${c}`).join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`
    ).run(Object.fromEntries(columns.map((c) => [c, row[c] ?? null])))
  }

  private deleteProjectLocally(db: Db, projectId: string, stamp: number, device: string): void {
    const keys = (db.prepare('SELECT storage_key FROM documents WHERE project_id = ?').all(projectId) as { storage_key: string }[]).map(
      (r) => r.storage_key
    )
    db.transaction(() => {
      for (const table of CHILD_TABLES) {
        // The children go with the project everywhere, so they need no tombstones of their own.
        for (const { id } of db.prepare(`SELECT id FROM ${table} WHERE project_id = ?`).all(projectId) as { id: string }[]) {
          this.setState(db, table, id, { hash: DELETED, stamp, device })
        }
        db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId)
      }
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    })()
    for (const key of keys) {
      if (STORAGE_KEY.test(key)) void unlink(join(this.opts.filesDir(), key)).catch(() => undefined)
    }
  }

  /** Makes sure a document's file is in the local store; false when it is not in the folder yet. */
  private async downloadFile(row: Row): Promise<boolean> {
    const storageKey = String(row.storage_key ?? '')
    if (!STORAGE_KEY.test(storageKey)) return false
    const local = join(this.opts.filesDir(), storageKey)
    if (existsSync(local)) return true
    const source = join(this.root, 'files', basename(storageKey))
    if (!existsSync(source)) return false
    let data: Buffer
    try {
      data = this.open(this.fileKey, await readFile(source), `file:${storageKey}`)
    } catch {
      return false
    }
    if (createHash('sha256').update(data).digest('hex') !== row.sha256) return false
    await this.atomicWrite(local, data)
    return true
  }

  // ---- crypto and files ----

  private seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(Buffer.from(aad))
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return Buffer.concat([Buffer.from('APVS1'), nonce, cipher.getAuthTag(), body])
  }

  private open(key: Buffer, blob: Buffer, aad: string): Buffer {
    if (blob.subarray(0, 5).toString() !== 'APVS1' || blob.length < 33) throw new Error('Not a sync file')
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(5, 17))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(blob.subarray(17, 33))
    return Buffer.concat([decipher.update(blob.subarray(33)), decipher.final()])
  }

  private async atomicWrite(path: string, data: Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
    await writeFile(tmp, data)
    // On Windows a cloud client may hold the old file open for a moment while it uploads it.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          await unlink(tmp).catch(() => undefined)
          throw err
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
      }
    }
  }
}
