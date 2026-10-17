import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { projectInputSchema, projectListQuerySchema, projectUpdateSchema } from '../../shared/schemas'
import type { Project, ProjectInput, ProjectListQuery, ProjectUpdate } from '../../shared/types'
import { assertUpdated, NotFoundError } from './errors'

interface ProjectRow {
  id: string
  name: string
  description: string
  type: string | null
  status: string
  website_url: string | null
  admin_url: string | null
  hosting_name: string | null
  domain_provider: string | null
  repository_url: string | null
  developer_name: string | null
  tech_stack_json: string
  tags_json: string
  custom_fields_json: string
  revision: number
  created_at: string
  updated_at: string
  archived_at: string | null
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type as Project['type'],
    status: row.status as Project['status'],
    websiteUrl: row.website_url,
    adminUrl: row.admin_url,
    hostingName: row.hosting_name,
    domainProvider: row.domain_provider,
    repositoryUrl: row.repository_url,
    developerName: row.developer_name,
    techStack: JSON.parse(row.tech_stack_json) as string[],
    tags: JSON.parse(row.tags_json) as string[],
    customFields: JSON.parse(row.custom_fields_json) as Project['customFields'],
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export class ProjectService {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  list(rawQuery: ProjectListQuery = {}): Project[] {
    const query = projectListQuerySchema.parse(rawQuery)
    const where: string[] = []
    const params: Record<string, string> = {}
    if (!query.includeArchived) where.push('archived_at IS NULL')
    if (query.search) {
      // Projects hold no secrets, so name/description/tags/tech stack/custom fields are safe to search.
      where.push(
        `(name LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\' OR tags_json LIKE @q ESCAPE '\\' OR tech_stack_json LIKE @q ESCAPE '\\' OR custom_fields_json LIKE @q ESCAPE '\\')`
      )
      params.q = `%${escapeLike(query.search)}%`
    }
    const sql = `SELECT * FROM projects ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, name COLLATE NOCASE`
    return (this.db.prepare(sql).all(params) as ProjectRow[]).map(toProject)
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    return row ? toProject(row) : null
  }

  require(id: string): Project {
    const project = this.get(id)
    if (!project) throw new NotFoundError('project')
    return project
  }

  create(rawInput: ProjectInput): Project {
    const input = projectInputSchema.parse(rawInput)
    const id = randomUUID()
    const timestamp = this.now()
    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, description, type, status, website_url, admin_url, hosting_name,
          domain_provider, repository_url, developer_name, tech_stack_json, tags_json, custom_fields_json,
          created_at, updated_at
        ) VALUES (
          @id, @name, @description, @type, @status, @websiteUrl, @adminUrl, @hostingName,
          @domainProvider, @repositoryUrl, @developerName, @techStack, @tags, @customFields,
          @timestamp, @timestamp
        )`
      )
      .run({
        ...input,
        id,
        techStack: JSON.stringify(input.techStack),
        tags: JSON.stringify(input.tags),
        customFields: JSON.stringify(input.customFields),
        timestamp
      })
    return this.get(id)!
  }

  update(raw: ProjectUpdate): Project {
    const { id, revision, input } = projectUpdateSchema.parse(raw)
    const result = this.db
      .prepare(
        `UPDATE projects SET
          name = @name, description = @description, type = @type, status = @status,
          website_url = @websiteUrl, admin_url = @adminUrl, hosting_name = @hostingName,
          domain_provider = @domainProvider, repository_url = @repositoryUrl,
          developer_name = @developerName, tech_stack_json = @techStack, tags_json = @tags,
          custom_fields_json = @customFields,
          revision = revision + 1, updated_at = @timestamp
        WHERE id = @id AND revision = @revision`
      )
      .run({
        ...input,
        id,
        revision,
        techStack: JSON.stringify(input.techStack),
        tags: JSON.stringify(input.tags),
        customFields: JSON.stringify(input.customFields),
        timestamp: this.now()
      })
    assertUpdated(result.changes, this.get(id) !== null, 'project')
    return this.require(id)
  }

  /**
   * Permanently removes the project with all its credentials, documents, notes and links.
   * Returns the storage keys of the project's document files so the caller can delete them.
   */
  delete(id: string): string[] {
    this.require(id)
    return this.db.transaction(() => {
      const keys = (this.db.prepare('SELECT storage_key FROM documents WHERE project_id = ?').all(id) as { storage_key: string }[]).map(
        (r) => r.storage_key
      )
      for (const table of ['credentials', 'documents', 'notes', 'links']) {
        this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id)
      }
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      return keys
    })()
  }

  /** Hides the project from the dashboard; its credentials, documents and notes stay intact. */
  archive(id: string): Project {
    return this.setArchived(id, this.now())
  }

  restore(id: string): Project {
    return this.setArchived(id, null)
  }

  private setArchived(id: string, archivedAt: string | null): Project {
    this.require(id)
    this.db
      .prepare(
        'UPDATE projects SET archived_at = @archivedAt, revision = revision + 1, updated_at = @timestamp WHERE id = @id'
      )
      .run({ id, archivedAt, timestamp: this.now() })
    return this.require(id)
  }
}
