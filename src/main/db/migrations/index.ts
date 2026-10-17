import { migration001Initial } from './001_initial'
import { migration002LinksRevision } from './002_links_revision'
import { migration003TeamDevices } from './003_team_devices'
import { migration004ProjectCustomFields } from './004_project_custom_fields'
import { migration005SyncState } from './005_sync_state'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Ordered list of schema migrations. Append only; never edit a released migration. */
export const migrations: Migration[] = [
  migration001Initial,
  migration002LinksRevision,
  migration003TeamDevices,
  migration004ProjectCustomFields,
  migration005SyncState
]
