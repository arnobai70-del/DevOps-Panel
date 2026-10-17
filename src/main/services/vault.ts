import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from '../db/database'
import { CredentialService } from './credentials'
import { DocumentService } from './documents'
import { Encryptor, type KeyProtector } from './encryption'
import { LinkService, NoteService } from './notes'
import { ProjectService } from './projects'

/** Everything the main process needs for one open vault folder. */
export class Vault {
  readonly projects: ProjectService
  readonly credentials: CredentialService
  readonly documents: DocumentService
  readonly notes: NoteService
  readonly links: LinkService

  private constructor(
    readonly dataDir: string,
    private readonly db: Db,
    readonly encryptor: Encryptor
  ) {
    this.projects = new ProjectService(db)
    this.credentials = new CredentialService(db, encryptor, this.projects)
    this.documents = new DocumentService(db, join(dataDir, 'files'), this.projects)
    this.notes = new NoteService(db, this.projects)
    this.links = new LinkService(db, this.projects)
  }

  static open(dataDir: string, protector: KeyProtector): Vault {
    for (const dir of [dataDir, join(dataDir, 'files'), join(dataDir, 'backups'), join(dataDir, 'logs')]) {
      mkdirSync(dir, { recursive: true })
    }
    const encryptor = Encryptor.loadOrCreate(dataDir, protector)
    return new Vault(dataDir, openDatabase(join(dataDir, 'vault.sqlite')), encryptor)
  }

  /** Deletes a project and everything in it, including its document files. */
  async deleteProject(id: string): Promise<void> {
    const storageKeys = this.projects.delete(id)
    await this.documents.discardFiles(storageKeys)
  }

  get database(): Db {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
