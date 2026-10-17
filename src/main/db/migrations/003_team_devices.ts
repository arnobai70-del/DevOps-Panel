import type { Migration } from './index'

export const migration003TeamDevices: Migration = {
  version: 3,
  name: 'team_devices',
  sql: `
CREATE TABLE team_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  address TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT
);
`
}
