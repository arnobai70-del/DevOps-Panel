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
  customFields: ProjectCustomField[]
  revision: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

export interface ProjectCustomField {
  label: string
  value: string
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

export interface BackupCounts {
  projects: number
  credentials: number
  documents: number
  notes: number
  links: number
}

export interface BackupStatus {
  lastBackupAt: string | null
  hasData: boolean
}

export interface BackupResult {
  path: string
  bytes: number
  createdAt: string
  counts: BackupCounts
}

export interface RestoreResult {
  backupCreatedAt: string
  counts: BackupCounts
  safetyCopyDir: string
}

export interface TeamDevice {
  id: string
  name: string
  address: string | null
  createdAt: string
  lastSeenAt: string | null
}

export interface TeamPendingRequest {
  id: string
  deviceName: string
  address: string | null
  requestedAt: string
}

export type TeamStatus =
  | { role: 'personal' }
  | {
      role: 'host'
      running: boolean
      error: string | null
      port: number
      addresses: string[]
      fingerprint: string
      code: { code: string; expiresAt: string } | null
      pending: TeamPendingRequest[]
      devices: TeamDevice[]
    }
  | {
      role: 'folder'
      folder: string
      teamName: string
      lastSyncAt: string | null
      /** Why the last sync failed (folder missing, cloud app not running…). */
      error: string | null
      /** Changes from teammates waiting for something (e.g. a file still uploading). */
      pending: number
    }
  | {
      role: 'google'
      /** The Google account whose Drive holds the team's data. */
      email: string
      lastSyncAt: string | null
      /** Why the last sync failed (offline, signed out…). */
      error: string | null
      pending: number
    }
  | {
      role: 'client'
      hostName: string
      address: string
      port: number
      fingerprint: string
      online: boolean
      /** Why the team vault cannot be used right now (offline, removed on the host, certificate changed). */
      error: string | null
    }

export interface AppInfo {
  version: string
  dataDir: string
  mode: 'personal' | 'host' | 'client' | 'folder' | 'google'
  keyProtection: 'safeStorage' | 'none'
  /** Whether a Google OAuth client is available on this PC (built in or imported). */
  googleConfigured: boolean
}

/** Result envelope for every IPC call, so the renderer gets a clean message instead of an Electron stack trace. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

export interface VaultAPI {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    /** Calls listener when teammates' changes arrive through folder sync; returns an unsubscribe. */
    onRemoteChange(listener: () => void): () => void
  }
  projects: {
    list(query?: ProjectListQuery): Promise<Project[]>
    get(id: string): Promise<Project>
    create(input: ProjectInput): Promise<Project>
    update(update: ProjectUpdate): Promise<Project>
    archive(id: string): Promise<Project>
    restore(id: string): Promise<Project>
    /** Permanently deletes the project with its credentials, documents, notes and links. */
    delete(id: string): Promise<void>
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
  team: {
    status(): Promise<TeamStatus>
    enableHost(): Promise<TeamStatus>
    disableHost(): Promise<TeamStatus>
    newCode(): Promise<TeamStatus>
    approve(requestId: string): Promise<TeamStatus>
    deny(requestId: string): Promise<TeamStatus>
    revoke(deviceId: string): Promise<TeamStatus>
    /** Contacts the host and sends a pairing request; returns the request id to poll. */
    join(input: { address: string; code: string; deviceName: string }): Promise<{ requestId: string; hostName: string; fingerprint: string }>
    /** Polls the host; on approval the app switches to the team vault. */
    joinStatus(requestId: string): Promise<'pending' | 'approved' | 'denied' | 'expired'>
    leave(): Promise<TeamStatus>
    /** Opens a folder picker; returns the chosen path or null. */
    chooseFolder(): Promise<string | null>
    createFolderTeam(input: { folder: string; teamName: string; passphrase: string }): Promise<TeamStatus>
    joinFolderTeam(input: { folder?: string; passphrase: string }): Promise<TeamStatus>
    syncNow(): Promise<TeamStatus>
    leaveFolder(): Promise<TeamStatus>
    /** Opens Google sign-in in the browser, then syncs through that account's Drive. */
    connectGoogle(): Promise<TeamStatus>
    cancelGoogleSignIn(): Promise<void>
    signOutGoogle(): Promise<TeamStatus>
    /** Asks for the Google OAuth client JSON file and keeps a copy in the app's data folder; false when cancelled. */
    importGoogleClient(): Promise<boolean>
  }
  backups: {
    status(): Promise<BackupStatus>
    /** Asks where to save, then writes an encrypted .apv backup; null when cancelled. */
    create(passphrase: string): Promise<BackupResult | null>
    /** Asks for an .apv file, verifies it, then replaces the current vault; null when cancelled. */
    restore(passphrase: string): Promise<RestoreResult | null>
    /** Encrypted backup straight into the app's Google Drive folder. */
    createInDrive(passphrase: string): Promise<BackupResult>
    /** Backup file names in Google Drive, newest first. */
    listInDrive(): Promise<string[]>
    restoreFromDrive(input: { name: string; passphrase: string }): Promise<RestoreResult>
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
