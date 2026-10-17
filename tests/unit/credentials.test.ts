import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/db/database'
import { CredentialService } from '../../src/main/services/credentials'
import { Encryptor } from '../../src/main/services/encryption'
import { ProjectService } from '../../src/main/services/projects'

let dir: string
let db: Db
let projects: ProjectService
let creds: CredentialService
let projectId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apv-cred-'))
  db = openDatabase(join(dir, 'vault.sqlite'))
  projects = new ProjectService(db)
  creds = new CredentialService(db, Encryptor.forKey(randomBytes(32)), projects)
  projectId = projects.create({ name: 'Shop' }).id
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('CredentialService', () => {
  it('saves secrets encrypted and lists only field names', () => {
    const c = creds.save({
      projectId,
      serviceName: 'WordPress admin',
      serviceUrl: 'https://shop.example.com/wp-admin',
      username: 'admin@shop.example.com',
      password: 'Hunter2-very-secret',
      apiKey: 'sk_live_ABCDEF123456',
      extras: [{ label: 'Recovery code', value: 'RC-998877' }]
    })
    expect(c.fields.map((f) => f.label)).toEqual(['Username / email', 'Password', 'API key', 'Recovery code'])
    expect(JSON.stringify(creds.list(projectId))).not.toContain('Hunter2')
    expect(creds.reveal(c.id, 'password')).toBe('Hunter2-very-secret')
    expect(creds.reveal(c.id, 'username')).toBe('admin@shop.example.com')
    expect(creds.reveal(c.id, c.fields[3]!.key)).toBe('RC-998877')
  })

  it('never writes plaintext secrets to the database file', () => {
    creds.save({ projectId, serviceName: 'Cloudflare', username: 'ops@agency.test', password: 'PlainTextCanary-42', apiKey: 'canary_api_key_77' })
    db.pragma('wal_checkpoint(TRUNCATE)')
    const raw = readFileSync(join(dir, 'vault.sqlite'))
    for (const canary of ['PlainTextCanary-42', 'canary_api_key_77', 'ops@agency.test']) {
      expect(raw.includes(Buffer.from(canary))).toBe(false)
    }
  })

  it('keeps, replaces and clears fields on edit', () => {
    const c = creds.save({ projectId, serviceName: 'Hosting', username: 'u1', password: 'p1', apiKey: 'k1', extras: [{ label: 'PIN', value: '1234' }] })
    const pinId = c.fields.find((f) => f.label === 'PIN')!.key.slice('extra:'.length)
    const edited = creds.save({
      id: c.id,
      revision: c.revision,
      projectId,
      serviceName: 'Hosting panel',
      password: 'p2',
      apiKey: null,
      extras: [{ id: pinId, label: 'PIN code' }, { label: 'Backup email', value: 'b@x.test' }]
    })
    expect(edited.serviceName).toBe('Hosting panel')
    expect(creds.reveal(c.id, 'username')).toBe('u1')
    expect(creds.reveal(c.id, 'password')).toBe('p2')
    expect(() => creds.reveal(c.id, 'apiKey')).toThrow(/not found/)
    expect(creds.reveal(c.id, `extra:${pinId}`)).toBe('1234')
    expect(edited.fields.map((f) => f.label)).toEqual(['Username / email', 'Password', 'PIN code', 'Backup email'])
  })

  it('rejects stale edits instead of overwriting', () => {
    const c = creds.save({ projectId, serviceName: 'A', password: 'x' })
    creds.save({ id: c.id, revision: c.revision, projectId, serviceName: 'B' })
    expect(() => creds.save({ id: c.id, revision: c.revision, projectId, serviceName: 'C' })).toThrow(/changed since you opened it/)
  })

  it('validates input and soft-deletes', () => {
    expect(() => creds.save({ projectId, serviceName: ' ' })).toThrow(/Service name is required/)
    expect(() => creds.save({ projectId, serviceName: 'X', serviceUrl: 'javascript:alert(1)' })).toThrow()
    expect(() => creds.reveal(randomBytes(16).toString('hex'), 'password')).toThrow()
    const c = creds.save({ projectId, serviceName: 'Gone', password: 'x' })
    creds.remove(c.id)
    expect(creds.list(projectId)).toEqual([])
    expect(() => creds.reveal(c.id, 'password')).toThrow(/not found/)
    expect(db.prepare('SELECT deleted_at FROM credentials WHERE id = ?').get(c.id)).toMatchObject({ deleted_at: expect.any(String) })
  })
})
