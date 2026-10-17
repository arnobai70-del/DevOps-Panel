import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/db/database'
import { ProjectService } from '../../src/main/services/projects'

let db: Db
let projects: ProjectService
let clock = 0

beforeEach(() => {
  db = openDatabase(':memory:')
  clock = 0
  projects = new ProjectService(db, () => new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString())
})

describe('ProjectService', () => {
  it('creates a project with only a name and sensible defaults', () => {
    const p = projects.create({ name: '  New Singapur Telecom  ' })
    expect(p).toMatchObject({
      name: 'New Singapur Telecom',
      description: '',
      type: null,
      status: 'active',
      websiteUrl: null,
      techStack: [],
      tags: [],
      customFields: [],
      revision: 1,
      archivedAt: null
    })
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('stores full details', () => {
    const p = projects.create({
      name: 'Shop',
      type: 'website',
      websiteUrl: 'https://shop.example.com',
      adminUrl: 'https://shop.example.com/wp-admin',
      hostingName: 'Hostinger',
      repositoryUrl: 'https://github.com/acme/shop',
      techStack: ['Laravel', 'React']
    })
    expect(projects.get(p.id)).toEqual(p)
    expect(p.techStack).toEqual(['Laravel', 'React'])
  })

  it('keeps custom fields in order, edits them, and finds projects by them', () => {
    const p = projects.create({
      name: 'Shop',
      customFields: [
        { label: ' Client phone ', value: ' 01711-000000 ' },
        { label: 'নবায়নের তারিখ', value: '2027-01-15' }
      ]
    })
    expect(p.customFields).toEqual([
      { label: 'Client phone', value: '01711-000000' },
      { label: 'নবায়নের তারিখ', value: '2027-01-15' }
    ])
    expect(projects.list({ search: '01711' }).map((x) => x.name)).toEqual(['Shop'])
    expect(projects.list({ search: 'নবায়ন' }).map((x) => x.name)).toEqual(['Shop'])
    const updated = projects.update({ id: p.id, revision: p.revision, input: { name: 'Shop', customFields: [{ label: 'Renewal', value: '' }] } })
    expect(updated.customFields).toEqual([{ label: 'Renewal', value: '' }])
    expect(() => projects.create({ name: 'A', customFields: [{ label: '  ', value: 'x' }] })).toThrow(/Field name is required/)
    expect(() =>
      projects.create({ name: 'A', customFields: Array.from({ length: 51 }, (_, i) => ({ label: `f${i}`, value: '' })) })
    ).toThrow()
  })

  it('rejects an empty name, overly long name and unsafe URLs', () => {
    expect(() => projects.create({ name: '   ' })).toThrow(/Project name is required/)
    expect(() => projects.create({ name: 'x'.repeat(151) })).toThrow()
    expect(() => projects.create({ name: 'A', websiteUrl: 'javascript:alert(1)' })).toThrow(/http\(s\) URL/)
    expect(() => projects.create({ name: 'A', websiteUrl: 'file:///C:/Windows' })).toThrow()
    expect(projects.list()).toHaveLength(0)
  })

  it('lists newest first and searches name, description and tech stack', () => {
    projects.create({ name: 'Alpha', description: 'telecom portal' })
    projects.create({ name: 'Beta', techStack: ['Laravel'] })
    projects.create({ name: 'Gamma' })
    expect(projects.list().map((p) => p.name)).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(projects.list({ search: 'TELECOM' }).map((p) => p.name)).toEqual(['Alpha'])
    expect(projects.list({ search: 'laravel' }).map((p) => p.name)).toEqual(['Beta'])
    expect(projects.list({ search: '%' })).toEqual([])
  })

  it('hides archived projects unless asked', () => {
    const p = projects.create({ name: 'Old' })
    db.prepare(`UPDATE projects SET archived_at = '2026-01-02T00:00:00.000Z' WHERE id = ?`).run(p.id)
    expect(projects.list()).toHaveLength(0)
    expect(projects.list({ includeArchived: true })).toHaveLength(1)
  })
})

describe('ProjectService edits', () => {
  it('updates with the current revision and rejects stale ones', () => {
    const p = projects.create({ name: 'Old name' })
    const updated = projects.update({ id: p.id, revision: p.revision, input: { name: 'New name', status: 'paused' } })
    expect(updated).toMatchObject({ name: 'New name', status: 'paused', revision: 2 })
    expect(() => projects.update({ id: p.id, revision: 1, input: { name: 'Lost update' } })).toThrow(/changed since you opened it/)
    expect(projects.get(p.id)!.name).toBe('New name')
  })

  it('archives and restores without touching other data', () => {
    const p = projects.create({ name: 'Keep me' })
    expect(projects.archive(p.id).archivedAt).not.toBeNull()
    expect(projects.list()).toEqual([])
    expect(projects.restore(p.id).archivedAt).toBeNull()
    expect(projects.list()).toHaveLength(1)
    expect(() => projects.archive('00000000-0000-4000-8000-000000000000')).toThrow(/not found/)
  })
})
