import type { Migration } from './index'

export const migration002LinksRevision: Migration = {
  version: 2,
  name: 'links_revision',
  sql: `
ALTER TABLE links ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE links ADD COLUMN updated_at TEXT;
UPDATE links SET updated_at = created_at WHERE updated_at IS NULL;
`
}
