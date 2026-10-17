import type { Db } from '../db/database'
import type { Encryptor } from '../services/encryption'

const aad = (id: string, field: string): string => `credential:${id}:${field}`

/**
 * Re-encrypts every credential (deleted ones too) from one vault key to another, in one
 * transaction. Used when a PC joins a team folder and adopts the team's shared key.
 */
export function rekeyCredentials(db: Db, from: Encryptor, to: Encryptor): number {
  const rows = db.prepare('SELECT id, username_cipher, secrets_cipher FROM credentials').all() as {
    id: string
    username_cipher: Buffer | null
    secrets_cipher: Buffer | null
  }[]
  const update = db.prepare('UPDATE credentials SET username_cipher = ?, secrets_cipher = ? WHERE id = ?')
  const move = (blob: Buffer | null, id: string, field: string): Buffer | null =>
    blob ? to.encrypt(from.decrypt(blob, aad(id, field)), aad(id, field)) : null
  db.transaction(() => {
    for (const r of rows) update.run(move(r.username_cipher, r.id, 'username'), move(r.secrets_cipher, r.id, 'secrets'), r.id)
  })()
  return rows.length
}
