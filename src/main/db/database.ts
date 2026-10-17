import Database from 'better-sqlite3'
import { migrations as defaultMigrations, type Migration } from './migrations'

export type Db = Database.Database

/**
 * Opens (or creates) the vault database and brings its schema up to date.
 * Pass ':memory:' for tests.
 */
export function openDatabase(filename: string, migrations: Migration[] = defaultMigrations): Db {
  const db = new Database(filename)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  try {
    migrate(db, migrations)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number
}

/** Applies pending migrations, each in its own transaction, so a failure leaves the previous version intact. */
export function migrate(db: Db, migrations: Migration[]): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  const current = schemaVersion(db)
  const latest = sorted.at(-1)?.version ?? 0
  if (current > latest) {
    throw new Error(
      `Vault database schema v${current} is newer than this app supports (v${latest}). Please update the app.`
    )
  }
  for (const m of sorted) {
    if (m.version <= current) continue
    db.transaction(() => {
      db.exec(m.sql)
      db.pragma(`user_version = ${m.version}`)
    })()
  }
}
