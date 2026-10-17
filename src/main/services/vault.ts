import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabase, type Db } from '../db/database'
import { ProjectService } from './projects'

/** Everything the main process needs for one open vault folder. */
export class Vault {
  readonly projects: ProjectService

  private constructor(
    readonly dataDir: string,
    private readonly db: Db
  ) {
    this.projects = new ProjectService(db)
  }

  static open(dataDir: string): Vault {
    for (const dir of [dataDir, join(dataDir, 'files'), join(dataDir, 'backups'), join(dataDir, 'logs')]) {
      mkdirSync(dir, { recursive: true })
    }
    return new Vault(dataDir, openDatabase(join(dataDir, 'vault.sqlite')))
  }

  close(): void {
    this.db.close()
  }
}
