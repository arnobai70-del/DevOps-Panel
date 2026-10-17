import type {
  CredentialField,
  CredentialSave,
  DocumentCreate,
  DocumentMetadata,
  DocumentUpdate,
  LinkSave,
  NoteSave,
  ProjectInput,
  ProjectListQuery,
  ProjectUpdate
} from './schemas'
import type { DOCUMENT_CATEGORIES, PROJECT_STATUSES, PROJECT_TYPES } from './constants'

export type ProjectType = (typeof PROJECT_TYPES)[number]
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number]

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

/** A credential as the renderer sees it: which fields are set, never their values. */
export interface CredentialSummary {
  id: string
  projectId: string
  serviceName: string
  serviceUrl: string | null
  notes: string
  fields: { key: CredentialField; label: string }[]
  revision: number
  createdAt: string
  updatedAt: string
}

export interface DocumentSummary {
  id: string
  projectId: string
  displayName: string
  purpose: string
  description: string
  category: DocumentCategory | null
  tags: string[]
  originalFilename: string
  mimeType: string | null
  fileSize: number
  sha256: string
  version: number
  revision: number
  createdAt: string
  updatedAt: string
}

export interface PickedFile {
  token: string
  filename: string
  size: number
}

export type DocumentPreview =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'none'; reason: string }

export interface Note {
  id: string
  projectId: string
  title: string
  body: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface Link {
  id: string
  projectId: string
  label: string
  url: string
  purpose: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AppInfo {
  version: string
  dataDir: string
  mode: 'personal'
  keyProtection: 'safeStorage' | 'none'
}

/** Result envelope for every IPC call, so the renderer gets a clean message instead of an Electron stack trace. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface VaultAPI {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
  }
  projects: {
    list(query?: ProjectListQuery): Promise<Project[]>
    get(id: string): Promise<Project>
    create(input: ProjectInput): Promise<Project>
    update(update: ProjectUpdate): Promise<Project>
    archive(id: string): Promise<Project>
    restore(id: string): Promise<Project>
  }
  credentials: {
    list(projectId: string): Promise<CredentialSummary[]>
    save(input: CredentialSave): Promise<CredentialSummary>
    reveal(id: string, field: CredentialField): Promise<string>
    /** Copies in the main process, so the value never passes through the page. */
    copy(id: string, field: CredentialField): Promise<void>
    remove(id: string): Promise<void>
  }
  documents: {
    list(projectId: string): Promise<DocumentSummary[]>
    /** Opens the native file picker; returns null when cancelled. */
    pickFile(): Promise<PickedFile | null>
    create(input: DocumentCreate): Promise<DocumentSummary>
    update(input: DocumentUpdate): Promise<DocumentSummary>
    preview(id: string): Promise<DocumentPreview>
    /** Opens the native save dialog; returns false when cancelled. */
    exportFile(id: string): Promise<boolean>
    openExternal(id: string): Promise<void>
    remove(id: string): Promise<void>
  }
  notes: {
    list(projectId: string): Promise<Note[]>
    save(input: NoteSave): Promise<Note>
    remove(id: string): Promise<void>
  }
  links: {
    list(projectId: string): Promise<Link[]>
    save(input: LinkSave): Promise<Link>
    remove(id: string): Promise<void>
  }
}

export type {
  CredentialField,
  CredentialSave,
  DocumentCreate,
  DocumentMetadata,
  DocumentUpdate,
  LinkSave,
  NoteSave,
  ProjectInput,
  ProjectListQuery,
  ProjectUpdate
}
