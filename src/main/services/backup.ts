import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions
} from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, type WriteStream } from 'node:fs'
import { appendFile, mkdir, open, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { openDatabase, type Db } from '../db/database'
import type { BackupCounts } from '../../shared/types'
import { Encryptor, type KeyProtector } from './encryption'

/*
 * .apv backup file layout
 *
 *   "APVBAK01" | u32 header length | header JSON | AES-256-GCM ciphertext | 16-byte GCM tag
 *
 * The header (authenticated as GCM AAD) holds the scrypt parameters, salt, nonce and a passphrase
 * check value. The ciphertext is a gzip of a flat entry stream:
 *
 *   u16 name length | name | u64 size | bytes      ... repeated, ended by a u16 0
 *
 * Entries: vault.key (the raw vault key, so credentials can be read on another PC), vault.sqlite
 * (a consistent online snapshot), files/<xx>/<uuid>.bin (documents) and manifest.json last, with
 * the size and SHA-256 of every other entry.
 */

const MAGIC = Buffer.from('APVBAK01', 'ascii')
const TAG_LEN = 16
const MAX_HEADER = 64 * 1024
const CHECK_LABEL = 'agency-project-vault-backup-check'
export const MIN_PASSPHRASE = 10

const DEFAULT_KDF = { N: 2 ** 17, r: 8, p: 1 }
const MAX_KDF_N = 2 ** 20

const SMALL_ENTRY_MAX = 10 * 1024 * 1024
const DB_ENTRY_MAX = 8 * 1024 ** 3
const FILE_ENTRY_MAX = 1024 ** 3
const TOTAL_MAX = 64 * 1024 ** 3
const MAX_ENTRIES = 1_000_000
const FILE_ENTRY = /^files\/[0-9a-f]{2}\/[0-9a-f-]{36}\.bin$/

/** Items in the data folder that make up the vault and are replaced by a restore. */
const VAULT_ITEMS = ['vault.sqlite', 'vault.sqlite-wal', 'vault.sqlite-shm', 'vault.key', 'files']

interface BackupHeader {
  format: 1
  createdAt: string
  appVersion: string
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  nonce: string
  check: string
}

interface ManifestEntry {
  name: string
  size: number
  sha256: string
}

interface Manifest {
  format: 1
  createdAt: string
  appVersion: string
  schemaVersion: number
  keyVersion: number
  counts: BackupCounts
  entries: ManifestEntry[]
}

interface OpenEntry {
  name: string
  remaining: number
  size: number
  hash: ReturnType<typeof createHash>
  /** Large entries stream to disk; small ones (key, manifest) stay in memory. */
  out: WriteStream | null
  chunks: Buffer[]
}

export interface StagedBackup {
  stagingDir: string
  manifest: Manifest
  key: Buffer
  keyVersion: number
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

function scrypt(passphrase: BinaryLike, salt: BinaryLike, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(passphrase, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

async function deriveKeys(passphrase: string, kdf: BackupHeader['kdf']): Promise<{ encKey: Buffer; check: Buffer }> {
  const material = await scrypt(passphrase.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), 64, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r
  })
  const check = createHmac('sha256', material.subarray(32)).update(CHECK_LABEL).digest()
  return { encKey: material.subarray(0, 32), check }
}

export function countRows(db: Db): BackupCounts {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n
  return {
    projects: count('SELECT COUNT(*) AS n FROM projects'),
    credentials: count('SELECT COUNT(*) AS n FROM credentials WHERE deleted_at IS NULL'),
    documents: count('SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL'),
    notes: count('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NULL'),
    links: count('SELECT COUNT(*) AS n FROM links WHERE deleted_at IS NULL')
  }
}

function entryHeader(name: string, size: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(2 + nameBuf.length + 8)
  head.writeUInt16BE(nameBuf.length, 0)
  nameBuf.copy(head, 2)
  head.writeBigUInt64BE(BigInt(size), 2 + nameBuf.length)
  return head
}

export interface CreateBackupOptions {
  db: Db
  dataDir: string
  encryptor: Encryptor
  destPath: string
  passphrase: string
  appVersion: string
  now?: () => string
  /** Tests use a cheaper KDF; the app uses the default. */
  kdf?: { N: number; r: number; p: number }
}

export async function createBackup(opts: CreateBackupOptions): Promise<{ bytes: number; createdAt: string; counts: BackupCounts }> {
  if (opts.passphrase.length < MIN_PASSPHRASE) {
    throw new BackupError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`)
  }
  const createdAt = (opts.now ?? (() => new Date().toISOString()))()
  const workDir = join(opts.dataDir, 'backups', `.tmp-${randomUUID()}`)
  const partPath = `${opts.destPath}.part`
  await mkdir(workDir, { recursive: true })
  try {
    const snapshot = join(workDir, 'vault.sqlite')
    await opts.db.backup(snapshot)
    const counts = countRows(opts.db)
    const schemaVersion = opts.db.pragma('user_version', { simple: true }) as number
    const storageKeys = (opts.db.prepare('SELECT storage_key FROM documents').all() as { storage_key: string }[]).map(
      (r) => r.storage_key
    )

    const params = opts.kdf ?? DEFAULT_KDF
    const kdf: BackupHeader['kdf'] = { name: 'scrypt', ...params, salt: randomBytes(16).toString('base64') }
    const { encKey, check } = await deriveKeys(opts.passphrase, kdf)
    const nonce = randomBytes(12)
    const header: BackupHeader = {
      format: 1,
      createdAt,
      appVersion: opts.appVersion,
      kdf,
      nonce: nonce.toString('base64'),
      check: check.toString('base64')
    }
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
    const prefix = Buffer.alloc(MAGIC.length + 4)
    MAGIC.copy(prefix)
    prefix.writeUInt32BE(headerBuf.length, MAGIC.length)

    const cipher = createCipheriv('aes-256-gcm', encKey, nonce)
    cipher.setAAD(headerBuf)

    const keyEntry = Buffer.from(
      JSON.stringify({ keyVersion: opts.encryptor.keyVersion, key: opts.encryptor.exportKey().toString('base64') })
    )
    const filesDir = join(opts.dataDir, 'files')

    async function* entries(): AsyncGenerator<Buffer> {
      const manifestEntries: ManifestEntry[] = []
      const small = (name: string, data: Buffer): Buffer[] => {
        manifestEntries.push({ name, size: data.length, sha256: createHash('sha256').update(data).digest('hex') })
        return [entryHeader(name, data.length), data]
      }
      async function* file(name: string, path: string): AsyncGenerator<Buffer> {
        const { size } = await stat(path)
        const hash = createHash('sha256')
        let seen = 0
        yield entryHeader(name, size)
        for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
          seen += chunk.length
          if (seen > size) throw new BackupError(`${name} changed while it was being backed up. Try again.`)
          hash.update(chunk)
          yield chunk
        }
        if (seen !== size) throw new BackupError(`${name} changed while it was being backed up. Try again.`)
        manifestEntries.push({ name, size, sha256: hash.digest('hex') })
      }

      yield* small('vault.key', keyEntry)
      yield* file('vault.sqlite', snapshot)
      for (const key of storageKeys) {
        const path = join(filesDir, key)
        if (existsSync(path)) yield* file(`files/${key}`, path)
      }
      const manifest: Manifest = {
        format: 1,
        createdAt,
        appVersion: opts.appVersion,
        schemaVersion,
        keyVersion: opts.encryptor.keyVersion,
        counts,
        entries: manifestEntries.slice()
      }
      yield* small('manifest.json', Buffer.from(JSON.stringify(manifest)))
      yield Buffer.alloc(2)
    }

    const out = createWriteStream(partPath, { flags: 'w' })
    out.write(prefix)
    out.write(headerBuf)
    await pipeline(Readable.from(entries()), createGzip({ level: 6 }), cipher, out)
    await appendFile(partPath, cipher.getAuthTag())
    await rename(partPath, opts.destPath)

    opts.db
      .prepare(`INSERT INTO app_meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(createdAt)
    return { bytes: (await stat(opts.destPath)).size, createdAt, counts }
  } catch (err) {
    await unlink(partPath).catch(() => undefined)
    throw err
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

export function lastBackupAt(db: Db): string | null {
  const row = db.prepare(`SELECT value FROM app_meta WHERE key = 'last_backup_at'`).get() as { value: string } | undefined
  return row?.value ?? null
}

/**
 * Decrypts a backup into stagingDir and verifies every entry against the manifest.
 * Nothing in the live vault is touched; a wrong passphrase or damaged file throws a BackupError.
 */
export async function readBackup(sourcePath: string, passphrase: string, stagingDir: string): Promise<StagedBackup> {
  const fd = await open(sourcePath, 'r')
  let header: BackupHeader
  let headerBuf: Buffer
  let tag: Buffer
  let bodyStart: number
  let bodyEnd: number
  try {
    const { size } = await fd.stat()
    const prefix = Buffer.alloc(MAGIC.length + 4)
    await fd.read(prefix, 0, prefix.length, 0)
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupError('This is not an Agency Project Vault backup (.apv) file.')
    }
    const headerLen = prefix.readUInt32BE(MAGIC.length)
    bodyStart = prefix.length + headerLen
    bodyEnd = size - TAG_LEN
    if (headerLen > MAX_HEADER || bodyEnd < bodyStart) throw new BackupError('The backup file is damaged or incomplete.')
    headerBuf = Buffer.alloc(headerLen)
    await fd.read(headerBuf, 0, headerLen, prefix.length)
    tag = Buffer.alloc(TAG_LEN)
    await fd.read(tag, 0, TAG_LEN, bodyEnd)
    try {
      header = JSON.parse(headerBuf.toString('utf8')) as BackupHeader
    } catch {
      throw new BackupError('The backup file is damaged or incomplete.')
    }
  } finally {
    await fd.close()
  }
  if (header.format !== 1 || header.kdf?.name !== 'scrypt') {
    throw new BackupError('This backup was made by a newer version of the app. Please update the app first.')
  }
  const { N, r, p } = header.kdf
  if (![N, r, p].every(Number.isInteger) || N > MAX_KDF_N || N < 2 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new BackupError('The backup file is damaged or incomplete.')
  }

  const { encKey, check } = await deriveKeys(passphrase, header.kdf)
  const expected = Buffer.from(header.check, 'base64')
  if (expected.length !== check.length || !timingSafeEqual(expected, check)) {
    throw new BackupError('Wrong passphrase for this backup.')
  }

  await mkdir(stagingDir, { recursive: true })
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(header.nonce, 'base64'))
  decipher.setAAD(headerBuf)
  decipher.setAuthTag(tag)

  const written = new Map<string, { size: number; sha256: string }>()
  const memory = new Map<string, Buffer>()

  async function parse(source: AsyncIterable<Buffer>): Promise<void> {
    let pending: Buffer = Buffer.alloc(0)
    let total = 0
    let done = false
    let current: OpenEntry | null = null

    const startEntry = (name: string, size: number): OpenEntry => {
      if (written.has(name) || memory.has(name)) throw new BackupError('The backup file is damaged (duplicate entry).')
      if (written.size + memory.size >= MAX_ENTRIES) throw new BackupError('The backup file has too many entries.')
      const limit =
        name === 'vault.sqlite' ? DB_ENTRY_MAX : FILE_ENTRY.test(name) ? FILE_ENTRY_MAX : name === 'vault.key' || name === 'manifest.json' ? SMALL_ENTRY_MAX : -1
      if (limit < 0) throw new BackupError('The backup file contains an unexpected entry.')
      if (size > limit) throw new BackupError('The backup file contains an entry that is too large.')
      total += size
      if (total > TOTAL_MAX) throw new BackupError('The backup is larger than this app will restore.')
      let out: WriteStream | null = null
      if (name === 'vault.sqlite' || FILE_ENTRY.test(name)) {
        const target = join(stagingDir, ...name.split('/'))
        mkdirSync(dirname(target), { recursive: true })
        out = createWriteStream(target, { flags: 'wx' })
      }
      return { name, remaining: size, size, hash: createHash('sha256'), out, chunks: [] }
    }

    const finishEntry = async (entry: OpenEntry): Promise<void> => {
      const sha256 = entry.hash.digest('hex')
      if (entry.out) {
        entry.out.end()
        await finished(entry.out)
        written.set(entry.name, { size: entry.size, sha256 })
      } else {
        memory.set(entry.name, Buffer.concat(entry.chunks))
        written.set(entry.name, { size: entry.size, sha256 })
      }
    }

    for await (const chunk of source) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      while (pending.length) {
        if (done) throw new BackupError('The backup file is damaged (unexpected trailing data).')
        if (current) {
          const entry = current
          const take = Math.min(entry.remaining, pending.length)
          const piece = pending.subarray(0, take)
          pending = pending.subarray(take)
          entry.hash.update(piece)
          entry.remaining -= take
          if (entry.out) {
            const out = entry.out
            if (!out.write(piece)) await new Promise<void>((resolve) => out.once('drain', () => resolve()))
          } else {
            entry.chunks.push(Buffer.from(piece))
          }
          if (entry.remaining === 0) {
            current = null
            await finishEntry(entry)
          }
          continue
        }
        if (pending.length < 2) break
        const nameLen = pending.readUInt16BE(0)
        if (nameLen === 0) {
          done = true
          pending = pending.subarray(2)
          continue
        }
        if (pending.length < 2 + nameLen + 8) break
        const name = pending.subarray(2, 2 + nameLen).toString('utf8')
        const size = pending.readBigUInt64BE(2 + nameLen)
        if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new BackupError('The backup file is damaged.')
        pending = pending.subarray(2 + nameLen + 8)
        const entry = startEntry(name, Number(size))
        if (entry.remaining === 0) await finishEntry(entry)
        else current = entry
      }
    }
    if (!done || current) throw new BackupError('The backup file is damaged or incomplete.')
  }

  try {
    await pipeline(
      createReadStream(sourcePath, { start: bodyStart, end: bodyEnd - 1 }),
      decipher,
      createGunzip(),
      parse
    )
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true })
    if (err instanceof BackupError) throw err
    throw new BackupError('The backup file is damaged or incomplete.')
  }

  try {
    const manifestBuf = memory.get('manifest.json')
    const keyBuf = memory.get('vault.key')
    if (!manifestBuf || !keyBuf || !written.has('vault.sqlite')) throw new BackupError('The backup file is incomplete.')
    const manifest = JSON.parse(manifestBuf.toString('utf8')) as Manifest
    const listed = new Set(manifest.entries.map((e) => e.name))
    for (const e of manifest.entries) {
      const got = written.get(e.name)
      if (!got || got.size !== e.size || got.sha256 !== e.sha256) {
        throw new BackupError(`The backup file is damaged (${e.name} does not match its checksum).`)
      }
    }
    for (const name of written.keys()) {
      if (name !== 'manifest.json' && !listed.has(name)) throw new BackupError('The backup file contains an unlisted entry.')
    }
    const keyJson = JSON.parse(keyBuf.toString('utf8')) as { keyVersion: number; key: string }
    const key = Buffer.from(keyJson.key, 'base64')
    if (key.length !== 32) throw new BackupError('The backup file is damaged (bad key).')
    mkdirSync(join(stagingDir, 'files'), { recursive: true })
    return { stagingDir, manifest, key, keyVersion: keyJson.keyVersion }
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true })
    if (err instanceof BackupError) throw err
    throw new BackupError('The backup file is damaged or incomplete.')
  }
}

/** Opens the staged database (applying any newer migrations), checks it, and returns its row counts. */
export function inspectStaged(staged: StagedBackup): BackupCounts {
  const db = openDatabase(join(staged.stagingDir, 'vault.sqlite'))
  try {
    const result = db.pragma('integrity_check', { simple: true })
    if (result !== 'ok') throw new BackupError('The database inside the backup failed its integrity check.')
    const encryptor = Encryptor.forKey(staged.key, staged.keyVersion)
    // Prove the key in the backup really opens the credentials in it.
    const sample = db.prepare('SELECT id, secrets_cipher FROM credentials WHERE secrets_cipher IS NOT NULL LIMIT 1').get() as
      | { id: string; secrets_cipher: Buffer }
      | undefined
    if (sample) {
      try {
        encryptor.decrypt(sample.secrets_cipher, `credential:${sample.id}:secrets`)
      } catch {
        throw new BackupError('The key inside the backup does not match its credentials.')
      }
    }
    db.prepare(`INSERT INTO app_meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
      staged.manifest.createdAt
    )
    return countRows(db)
  } finally {
    db.close()
  }
}

/**
 * Replaces the vault in dataDir with a staged backup. The vault must be closed.
 * The previous vault is moved (not copied) to backups/pre-restore-<time>/ and moved back if anything fails.
 */
export function swapInStaged(dataDir: string, staged: StagedBackup, protector: KeyProtector, now = new Date()): string {
  const safetyDir = join(dataDir, 'backups', `pre-restore-${now.toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(safetyDir, { recursive: true })
  const moved: string[] = []
  try {
    for (const item of VAULT_ITEMS) {
      if (existsSync(join(dataDir, item))) {
        renameSync(join(dataDir, item), join(safetyDir, item))
        moved.push(item)
      }
    }
    for (const item of ['vault.sqlite', 'vault.sqlite-wal', 'vault.sqlite-shm', 'files']) {
      if (existsSync(join(staged.stagingDir, item))) renameSync(join(staged.stagingDir, item), join(dataDir, item))
    }
    Encryptor.writeKeyFile(dataDir, staged.key, staged.keyVersion, protector)
  } catch (err) {
    for (const item of VAULT_ITEMS) rmSync(join(dataDir, item), { recursive: true, force: true })
    for (const item of moved) renameSync(join(safetyDir, item), join(dataDir, item))
    rmSync(safetyDir, { recursive: true, force: true })
    throw err
  }
  return safetyDir
}
