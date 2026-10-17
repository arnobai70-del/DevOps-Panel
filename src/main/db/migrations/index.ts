import { migration001Initial } from './001_initial'
import { migration002LinksRevision } from './002_links_revision'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Ordered list of schema migrations. Append only; never edit a released migration. */
export const migrations: Migration[] = [migration001Initial, migration002LinksRevision]
