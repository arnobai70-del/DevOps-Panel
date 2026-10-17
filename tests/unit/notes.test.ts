import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../src/main/db/database'
import { LinkService, NoteService } from '../../src/main/services/notes'
import { ProjectService } from '../../src/main/services/projects'

let notes: NoteService
let links: LinkService
let projectId: string

beforeEach(() => {
  const db = openDatabase(':memory:')
  const projects = new ProjectService(db)
  notes = new NoteService(db, projects)
  links = new LinkService(db, projects)
  projectId = projects.create({ name: 'P' }).id
})

describe('NoteService', () => {
  it('creates, edits with revision check and deletes notes', () => {
    const n = notes.save({ projectId, title: 'Deploy', body: 'ssh then pull' })
    const edited = notes.save({ id: n.id, revision: n.revision, projectId, title: 'Deploy steps', body: 'b' })
    expect(edited).toMatchObject({ title: 'Deploy steps', revision: 2 })
    expect(() => notes.save({ id: n.id, revision: 1, projectId, title: 'x' })).toThrow(/changed since/)
    notes.remove(n.id)
    expect(notes.list(projectId)).toEqual([])
    expect(() => notes.save({ projectId, title: '' })).toThrow(/Title is required/)
  })
})

describe('LinkService', () => {
  it('accepts only http(s) links', () => {
    const l = links.save({ projectId, label: 'Staging', url: 'https://staging.example.com', purpose: 'QA' })
    expect(links.list(projectId)).toEqual([l])
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'powershell:ls', 'not a url']) {
      expect(() => links.save({ projectId, label: 'Bad', url })).toThrow()
    }
    links.remove(l.id)
    expect(links.list(projectId)).toEqual([])
  })
})
