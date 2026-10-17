import type { ProjectInput, ProjectListQuery } from './schemas'
import type { PROJECT_STATUSES, PROJECT_TYPES } from './constants'

export type ProjectType = (typeof PROJECT_TYPES)[number]
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface Project {
  id: string
  name: string
  description: string
  type: ProjectType | null
  status: ProjectStatus
  websiteUrl: string | null
  adminUrl: string | null
  hostingName: string | null
  domainProvider: string | null
  repositoryUrl: string | null
  developerName: string | null
  techStack: string[]
  tags: string[]
  revision: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface AppInfo {
  version: string
  dataDir: string
  mode: 'personal'
}

/** Result envelope for every IPC call, so the renderer gets a clean message instead of an Electron stack trace. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface VaultAPI {
  app: {
    info(): Promise<AppInfo>
  }
  projects: {
    list(query?: ProjectListQuery): Promise<Project[]>
    create(input: ProjectInput): Promise<Project>
  }
}

export type { ProjectInput, ProjectListQuery }
