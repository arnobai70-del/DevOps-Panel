import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { linkSaveSchema, noteSaveSchema } from '../../shared/schemas'
import type { Link, LinkSave, Note, NoteSave } from '../../shared/types'
import { assertUpdated, NotFoundError } from './errors'
import type { ProjectService } from './projects'

interface NoteRow {
  id: string
  project_id: string
  title: string
  body: string
  revision: number
  created_at: string
  updated_at: string
}

interface LinkRow {
  id: string
  project_id: string
  label: string
  url: string
  purpose: string | null
  revision: number
  created_at: string
  updated_at: string
}

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  body: r.body,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const toLink = (r: LinkRow): Link => ({
  id: r.id,
  projectId: r.project_id,
  label: r.label,
  url: r.url,
  purpose: r.purpose,
  revision: r.revision,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export class NoteService {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  list(projectId: string): Note[] {
    return (
      this.db
        .prepare('SELECT * FROM notes WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC')
        .all(projectId) as NoteRow[]
    ).map(toNote)
  }

  save(raw: NoteSave): Note {
    const input = noteSaveSchema.parse(raw)
    this.projects.require(input.projectId)
    const timestamp = this.now()
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE notes SET title = @title, body = @body, revision = revision + 1, updated_at = @timestamp
          WHERE id = @id AND revision = @revision AND deleted_at IS NULL`
        )
        .run({ ...input, revision: input.revision ?? 0, timestamp })
      assertUpdated(result.changes, this.get(input.id) !== null, 'note')
      return this.get(input.id)!
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO notes (id, project_id, title, body, created_at, updated_at)
        VALUES (@id, @projectId, @title, @body, @timestamp, @timestamp)`
      )
      .run({ ...input, id, timestamp })
    return this.get(id)!
  }

  remove(id: string): void {
    const result = this.db
      .prepare('UPDATE notes SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(this.now(), id)
    if (result.changes === 0) throw new NotFoundError('note')
  }

  private get(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id) as
      | NoteRow
      | undefined
    return row ? toNote(row) : null
  }
}

export class LinkService {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  list(projectId: string): Link[] {
    return (
      this.db
        .prepare('SELECT * FROM links WHERE project_id = ? AND deleted_at IS NULL ORDER BY label COLLATE NOCASE')
        .all(projectId) as LinkRow[]
    ).map(toLink)
  }

  save(raw: LinkSave): Link {
    const input = linkSaveSchema.parse(raw)
    this.projects.require(input.projectId)
    const timestamp = this.now()
    if (input.id) {
      const result = this.db
        .prepare(
          `UPDATE links SET label = @label, url = @url, purpose = @purpose, revision = revision + 1, updated_at = @timestamp
          WHERE id = @id AND revision = @revision AND deleted_at IS NULL`
        )
        .run({ ...input, revision: input.revision ?? 0, timestamp })
      assertUpdated(result.changes, this.get(input.id) !== null, 'link')
      return this.get(input.id)!
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO links (id, project_id, label, url, purpose, created_at, updated_at)
        VALUES (@id, @projectId, @label, @url, @purpose, @timestamp, @timestamp)`
      )
      .run({ ...input, id, timestamp })
    return this.get(id)!
  }

  remove(id: string): void {
    const result = this.db
      .prepare('UPDATE links SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(this.now(), id)
    if (result.changes === 0) throw new NotFoundError('link')
  }

  private get(id: string): Link | null {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ? AND deleted_at IS NULL').get(id) as
      | LinkRow
      | undefined
    return row ? toLink(row) : null
  }
}
