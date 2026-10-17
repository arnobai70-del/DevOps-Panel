import type { Migration } from './index'

export const migration004ProjectCustomFields: Migration = {
  version: 4,
  name: 'project_custom_fields',
  sql: `ALTER TABLE projects ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '[]';`
}
