import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, schemaVersion } from '../../src/main/db/database'
import { migrations } from '../../src/main/db/migrations'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it('creates the full schema at the latest version with foreign keys on', () => {
    const db = openDatabase(':memory:')
    expect(schemaVersion(db)).toBe(migrations.at(-1)!.version)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]).map(
      (r) => r.name
    )
    expect(tables).toEqual(['app_meta', 'credentials', 'documents', 'links', 'notes', 'projects', 'sync_state', 'team_devices'])
    expect(db.prepare('SELECT revision, updated_at FROM links').all()).toEqual([])
    db.close()
  })

  it('is idempotent across reopen and keeps data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apv-'))
    dirs.push(dir)
    const file = join(dir, 'vault.sqlite')
    const first = openDatabase(file)
    first.prepare(`INSERT INTO app_meta (key, value) VALUES ('k', 'v')`).run()
    first.close()
    const second = openDatabase(file)
    expect(second.prepare(`SELECT value FROM app_meta WHERE key='k'`).get()).toEqual({ value: 'v' })
    second.close()
  })

  it('rolls back a failing migration and keeps the previous version', () => {
    const db = openDatabase(':memory:')
    const before = schemaVersion(db)
    expect(() =>
      migrate(db, [...migrations, { version: before + 1, name: 'broken', sql: 'CREATE TABLE ok_t (x); SELECT * FROM nope;' }])
    ).toThrow()
    expect(schemaVersion(db)).toBe(before)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='ok_t'`).get()).toBeUndefined()
    db.close()
  })

  it('refuses a database created by a newer app version', () => {
    const db = openDatabase(':memory:')
    db.pragma('user_version = 999')
    expect(() => migrate(db, migrations)).toThrow(/newer than this app supports/)
    db.close()
  })
})
