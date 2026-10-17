import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { SyncStore } from '../sync/store'

/**
 * The few Google Drive REST calls team sync needs. With the drive.file scope the app sees only
 * files it created itself, so every PC signed in to the same Google account shares one app folder,
 * "Agency Project Vault", in My Drive, and nothing else in that Drive is ever visible to the app.
 */

const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DRIVE_FOLDER_NAME = 'Agency Project Vault'
const MARK = { key: 'apv', value: 'team-v1' }

const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  md5Checksum: z.string().optional(),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional()
})
type DriveFile = z.infer<typeof fileSchema>
const listSchema = z.object({ files: z.array(fileSchema), nextPageToken: z.string().optional() })

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class DriveClient {
  constructor(
    private readonly accessToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = fetch
  ) {}

  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken()
    let res: Response
    try {
      res = await this.fetchFn(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
    } catch {
      throw new DriveError('Cannot reach Google Drive. Check the internet connection.', 0)
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
      const reason = body.error?.message ?? `HTTP ${res.status}`
      if (res.status === 403 && /quota|storage/i.test(reason)) throw new DriveError('Google Drive is full.', 403)
      throw new DriveError(`Google Drive: ${reason}`, res.status)
    }
    return res
  }

  /** The app's team folder, created in My Drive the first time. The oldest wins if two PCs raced. */
  async teamFolder(): Promise<string> {
    const q = `mimeType='${FOLDER_MIME}' and trashed=false and appProperties has { key='${MARK.key}' and value='${MARK.value}' }`
    const found = await this.query(q, 'createdTime')
    if (found[0]) return found[0].id
    const res = await this.call(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [MARK.key]: MARK.value } })
    })
    return z.object({ id: z.string() }).parse(await res.json()).id
  }

  async folderAlive(folderId: string): Promise<boolean> {
    try {
      const res = await this.call(`${API}/files/${encodeURIComponent(folderId)}?fields=id,name,trashed`)
      return !fileSchema.parse(await res.json()).trashed
    } catch (err) {
      if (err instanceof DriveError && err.status === 404) return false
      throw err
    }
  }

  children(folderId: string): Promise<DriveFile[]> {
    return this.query(`'${folderId}' in parents and trashed=false`, 'modifiedTime')
  }

  private async query(q: string, orderBy: string): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q,
        orderBy,
        pageSize: '1000',
        spaces: 'drive',
        fields: 'nextPageToken,files(id,name,md5Checksum,modifiedTime,trashed)'
      })
      if (pageToken) params.set('pageToken', pageToken)
      const page = listSchema.parse(await (await this.call(`${API}/files?${params}`)).json())
      out.push(...page.files)
      pageToken = page.nextPageToken
    } while (pageToken)
    return out
  }

  async download(fileId: string): Promise<Buffer> {
    return Buffer.from(await (await this.call(`${API}/files/${encodeURIComponent(fileId)}?alt=media`)).arrayBuffer())
  }

  async create(folderId: string, name: string, data: Buffer): Promise<DriveFile> {
    const boundary = `apv${randomBytes(12).toString('hex')}`
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folderId] })}\r\n`),
      Buffer.from(`--${boundary}\r\ncontent-type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`)
    ])
    const res = await this.call(`${UPLOAD}/files?uploadType=multipart&fields=id,name,md5Checksum,modifiedTime`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body
    })
    return fileSchema.parse(await res.json())
  }

  async update(fileId: string, data: Buffer): Promise<DriveFile> {
    const res = await this.call(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,md5Checksum,modifiedTime`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/octet-stream' },
      body: data
    })
    return fileSchema.parse(await res.json())
  }
}

/** Team sync files kept flat in the app's Drive folder, named by their sync path. */
export class DriveStore implements SyncStore {
  private files = new Map<string, DriveFile>()
  private loaded = false

  constructor(
    private readonly drive: DriveClient,
    readonly folderId: string
  ) {}

  /** Lists the folder once per sync round; the other calls use that listing. */
  async check(): Promise<void> {
    if (!(await this.drive.folderAlive(this.folderId))) {
      throw new Error(`The "${DRIVE_FOLDER_NAME}" folder was removed from Google Drive. Sign out and sign in again to start a new one.`)
    }
    await this.refresh()
  }

  private async refresh(): Promise<void> {
    const files = new Map<string, DriveFile>()
    // Sorted oldest first, so if a name exists twice the newest copy is the one kept.
    for (const file of await this.drive.children(this.folderId)) files.set(file.name, file)
    this.files = files
    this.loaded = true
  }

  async list(prefix: string): Promise<Map<string, string>> {
    if (!this.loaded) await this.refresh()
    const out = new Map<string, string>()
    for (const [name, file] of this.files) if (name.startsWith(prefix)) out.set(name, signature(file))
    return out
  }

  async read(path: string): Promise<Buffer | null> {
    if (!this.loaded) await this.refresh()
    let file = this.files.get(path)
    if (!file) {
      await this.refresh()
      file = this.files.get(path)
    }
    return file ? this.drive.download(file.id) : null
  }

  async has(path: string): Promise<boolean> {
    if (!this.loaded) await this.refresh()
    return this.files.has(path)
  }

  async write(path: string, data: Buffer): Promise<string> {
    if (!this.loaded) await this.refresh()
    const existing = this.files.get(path)
    const file = existing ? await this.drive.update(existing.id, data) : await this.drive.create(this.folderId, path, data)
    this.files.set(path, file)
    return signature(file)
  }
}

const signature = (file: DriveFile): string => `${file.id}:${file.md5Checksum ?? file.modifiedTime ?? ''}`
