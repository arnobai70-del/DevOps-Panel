import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { projectInputSchema, projectListQuerySchema } from '../../shared/schemas'
import type { Project, ProjectInput, ProjectListQuery } from '../../shared/types'

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
      // Projects hold no secrets, so name/description/tags/tech stack are safe to search.
      where.push(
        `(name LIKE @q ESCAPE '\\' OR description LIKE @q ESCAPE '\\' OR tags_json LIKE @q ESCAPE '\\' OR tech_stack_json LIKE @q ESCAPE '\\')`
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

  create(rawInput: ProjectInput): Project {
    const input = projectInputSchema.parse(rawInput)
    const id = randomUUID()
    const timestamp = this.now()
    this.db
      .prepare(
        `INSERT INTO projects (
          id, name, description, type, status, website_url, admin_url, hosting_name,
          domain_provider, repository_url, developer_name, tech_stack_json, tags_json,
          created_at, updated_at
        ) VALUES (
          @id, @name, @description, @type, @status, @websiteUrl, @adminUrl, @hostingName,
          @domainProvider, @repositoryUrl, @developerName, @techStack, @tags,
          @timestamp, @timestamp
        )`
      )
      .run({
        ...input,
        id,
        techStack: JSON.stringify(input.techStack),
        tags: JSON.stringify(input.tags),
        timestamp
      })
    return this.get(id)!
  }
}
