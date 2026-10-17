import type { Migration } from './index'

export const migration001Initial: Migration = {
  version: 1,
  name: 'initial',
  sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  website_url TEXT,
  admin_url TEXT,
  hosting_name TEXT,
  domain_provider TEXT,
  repository_url TEXT,
  developer_name TEXT,
  tech_stack_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  service_name TEXT NOT NULL,
  service_url TEXT,
  username_cipher BLOB,
  secrets_cipher BLOB,
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  original_filename TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  purpose TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX idx_credentials_project ON credentials(project_id);
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_notes_project ON notes(project_id);
CREATE INDEX idx_links_project ON links(project_id);
CREATE INDEX idx_projects_name ON projects(name);
`
}
