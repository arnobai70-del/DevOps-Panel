import { migration001Initial } from './001_initial'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Ordered list of schema migrations. Append only; never edit a released migration. */
export const migrations: Migration[] = [migration001Initial]
