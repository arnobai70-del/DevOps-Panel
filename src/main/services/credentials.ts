import { randomUUID } from 'node:crypto'
import type { Db } from '../db/database'
import { credentialFieldSchema, credentialSaveSchema } from '../../shared/schemas'
import type { CredentialField, CredentialSave, CredentialSummary } from '../../shared/types'
import type { Encryptor } from './encryption'
import { assertUpdated, NotFoundError } from './errors'
import type { ProjectService } from './projects'

interface CredentialRow {
  id: string
  project_id: string
  service_name: string
  service_url: string | null
  username_cipher: Buffer | null
  secrets_cipher: Buffer | null
  notes: string
  revision: number
  created_at: string
  updated_at: string
}

/** Everything secret about one credential; stored only as ciphertext. */
interface SecretBundle {
  password?: string
  apiKey?: string
  apiSecret?: string
  extras: { id: string; label: string; value: string }[]
}

const STANDARD_LABELS = { username: 'Username / email', password: 'Password', apiKey: 'API key', apiSecret: 'API secret' }

export class CredentialService {
  constructor(
    private readonly db: Db,
    private readonly encryptor: Encryptor,
    private readonly projects: ProjectService,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  list(projectId: string): CredentialSummary[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM credentials WHERE project_id = ? AND deleted_at IS NULL ORDER BY service_name COLLATE NOCASE'
      )
      .all(projectId) as CredentialRow[]
    return rows.map((row) => this.toSummary(row))
  }

  save(raw: CredentialSave): CredentialSummary {
    const input = credentialSaveSchema.parse(raw)
    this.projects.require(input.projectId)

    const existing = input.id ? this.row(input.id) : null
    if (input.id && !existing) throw new NotFoundError('credential')
    const id = existing?.id ?? randomUUID()

    const oldUsername = existing ? this.decryptUsername(existing) : undefined
    const oldBundle = existing ? this.decryptBundle(existing) : { extras: [] }

    const username = merge(oldUsername, input.username)
    const bundle: SecretBundle = {
      password: merge(oldBundle.password, input.password),
      apiKey: merge(oldBundle.apiKey, input.apiKey),
      apiSecret: merge(oldBundle.apiSecret, input.apiSecret),
      extras: input.extras
        ? input.extras.map((extra) => {
            const kept = extra.id ? oldBundle.extras.find((e) => e.id === extra.id) : undefined
            if (extra.id && !kept && extra.value === undefined) throw new NotFoundError('extra field')
            return { id: kept?.id ?? randomUUID(), label: extra.label, value: extra.value ?? kept!.value }
          })
        : oldBundle.extras
    }

    const params = {
      id,
      projectId: input.projectId,
      serviceName: input.serviceName,
      serviceUrl: input.serviceUrl,
      notes: input.notes,
      usernameCipher: username === undefined ? null : this.encryptor.encrypt(username, aad(id, 'username')),
      secretsCipher: this.encryptor.encrypt(JSON.stringify(bundle), aad(id, 'secrets')),
      timestamp: this.now()
    }

    if (existing) {
      if (input.revision === undefined) throw new Error('revision is required to edit a credential')
      const result = this.db
        .prepare(
          `UPDATE credentials SET
            project_id = @projectId, service_name = @serviceName, service_url = @serviceUrl, notes = @notes,
            username_cipher = @usernameCipher, secrets_cipher = @secretsCipher,
            revision = revision + 1, updated_at = @timestamp
          WHERE id = @id AND revision = @revision AND deleted_at IS NULL`
        )
        .run({ ...params, revision: input.revision })
      assertUpdated(result.changes, true, 'credential')
    } else {
      this.db
        .prepare(
          `INSERT INTO credentials (
            id, project_id, service_name, service_url, notes, username_cipher, secrets_cipher, created_at, updated_at
          ) VALUES (
            @id, @projectId, @serviceName, @serviceUrl, @notes, @usernameCipher, @secretsCipher, @timestamp, @timestamp
          )`
        )
        .run(params)
    }
    return this.toSummary(this.row(id)!)
  }

  reveal(id: string, rawField: CredentialField): string {
    const field = credentialFieldSchema.parse(rawField)
    const row = this.row(id)
    if (!row) throw new NotFoundError('credential')
    if (field === 'username') {
      const value = this.decryptUsername(row)
      if (value === undefined) throw new NotFoundError('field')
      return value
    }
    const bundle = this.decryptBundle(row)
    const value = field.startsWith('extra:')
      ? bundle.extras.find((e) => `extra:${e.id}` === field)?.value
      : bundle[field as 'password' | 'apiKey' | 'apiSecret']
    if (value === undefined) throw new NotFoundError('field')
    return value
  }

  /** Soft delete: the row stays (encrypted) so it can be recovered from the database or a backup. */
  remove(id: string): void {
    const result = this.db
      .prepare('UPDATE credentials SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND deleted_at IS NULL')
      .run(this.now(), id)
    if (result.changes === 0) throw new NotFoundError('credential')
  }

  private row(id: string): CredentialRow | null {
    return (
      (this.db.prepare('SELECT * FROM credentials WHERE id = ? AND deleted_at IS NULL').get(id) as
        | CredentialRow
        | undefined) ?? null
    )
  }

  private decryptUsername(row: CredentialRow): string | undefined {
    return row.username_cipher ? this.encryptor.decrypt(row.username_cipher, aad(row.id, 'username')) : undefined
  }

  private decryptBundle(row: CredentialRow): SecretBundle {
    if (!row.secrets_cipher) return { extras: [] }
    return JSON.parse(this.encryptor.decrypt(row.secrets_cipher, aad(row.id, 'secrets'))) as SecretBundle
  }

  private toSummary(row: CredentialRow): CredentialSummary {
    const bundle = this.decryptBundle(row)
    const fields: CredentialSummary['fields'] = []
    if (row.username_cipher) fields.push({ key: 'username', label: STANDARD_LABELS.username })
    for (const key of ['password', 'apiKey', 'apiSecret'] as const) {
      if (bundle[key] !== undefined) fields.push({ key, label: STANDARD_LABELS[key] })
    }
    for (const extra of bundle.extras) fields.push({ key: `extra:${extra.id}`, label: extra.label })
    return {
      id: row.id,
      projectId: row.project_id,
      serviceName: row.service_name,
      serviceUrl: row.service_url,
      notes: row.notes,
      fields,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }
}

function aad(id: string, field: string): string {
  return `credential:${id}:${field}`
}

/** undefined keeps the old value; null or '' clears it; anything else replaces it. */
function merge(old: string | undefined, next: string | null | undefined): string | undefined {
  if (next === undefined) return old
  if (next === null || next === '') return undefined
  return next
}
