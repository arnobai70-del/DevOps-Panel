import type { Migration } from './index'

/** What this PC last wrote to or read from a team sync folder, per row (see sync/folderSync.ts). */
export const migration005SyncState: Migration = {
  version: 5,
  name: 'sync_state',
  sql: `
CREATE TABLE sync_state (
  tbl TEXT NOT NULL,
  id TEXT NOT NULL,
  hash TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  device TEXT NOT NULL,
  PRIMARY KEY (tbl, id)
);
`
}
