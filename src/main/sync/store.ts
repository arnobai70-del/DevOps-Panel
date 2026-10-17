import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { teamDir } from './teamFolder'

/**
 * Where team sync keeps its encrypted files. Paths are relative and use '/', e.g.
 * records/projects/<id>/<device>.rec or files/<uuid>.bin. A signature changes whenever a file's
 * content does, so a sync round only reads files that changed.
 */
export interface SyncStore {
  /** Throws a readable error when the store cannot be reached right now. */
  check(): Promise<void>
  /** Every file under prefix, mapped to its signature. */
  list(prefix: string): Promise<Map<string, string>>
  read(path: string): Promise<Buffer | null>
  has(path: string): Promise<boolean>
  /** Creates or replaces the file; returns its new signature. */
  write(path: string, data: Buffer): Promise<string>
}

/** A team folder on disk (inside Google Drive for desktop, OneDrive, Dropbox or a network share). */
export class FolderStore implements SyncStore {
  private readonly root: string

  constructor(folder: string) {
    this.root = teamDir(folder)
  }

  async check(): Promise<void> {
    if (!existsSync(join(this.root, 'team.json'))) {
      throw new Error('The team folder is not available. Check that Google Drive / OneDrive is running and the folder still exists.')
    }
  }

  async list(prefix: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(join(this.root, rel), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = `${rel}/${entry.name}`
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile() && !entry.name.startsWith('.')) {
          const info = await stat(join(this.root, child)).catch(() => null)
          if (info) out.set(child, `${info.mtimeMs}:${info.size}`)
        }
      }
    }
    await walk(prefix.replace(/\/$/, ''))
    return out
  }

  async read(path: string): Promise<Buffer | null> {
    return readFile(join(this.root, path)).catch(() => null)
  }

  async has(path: string): Promise<boolean> {
    return existsSync(join(this.root, path))
  }

  async write(path: string, data: Buffer): Promise<string> {
    const full = join(this.root, path)
    await atomicWrite(full, data)
    const info = await stat(full)
    return `${info.mtimeMs}:${info.size}`
  }
}

export async function atomicWrite(path: string, data: Buffer): Promise<void> {
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
