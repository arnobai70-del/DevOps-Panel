import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Wraps the vault key at rest. In the app this is Electron safeStorage (Windows DPAPI). */
export interface KeyProtector {
  readonly name: 'safeStorage' | 'none'
  protect(key: Buffer): Buffer
  unprotect(blob: Buffer): Buffer
}

/** Used only when the OS offers no key protection (e.g. Linux without a keyring) and in tests. */
export const unprotectedKeys: KeyProtector = {
  name: 'none',
  protect: (key) => Buffer.from(key),
  unprotect: (blob) => Buffer.from(blob)
}

interface KeyFile {
  format: 1
  protection: KeyProtector['name']
  keyVersion: number
  key: string
}

const KEY_FILE = 'vault.key'
const FORMAT = 1
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = 2

/**
 * AES-256-GCM field encryption with a random per-vault key.
 *
 * Ciphertext layout: [format:1][keyVersion:1][nonce:12][tag:16][ciphertext].
 * Each value is bound to its record and field through the AAD, so a ciphertext copied
 * onto another row or field fails to decrypt instead of silently revealing the wrong secret.
 */
export class Encryptor {
  private constructor(
    private readonly key: Buffer,
    readonly keyVersion: number,
    readonly protection: KeyProtector['name']
  ) {}

  static forKey(key: Buffer, keyVersion = 1, protection: KeyProtector['name'] = 'none'): Encryptor {
    if (key.length !== 32) throw new Error('Vault key must be 32 bytes')
    return new Encryptor(Buffer.from(key), keyVersion, protection)
  }

  /** Loads the vault key from dataDir, creating one on first run. */
  static loadOrCreate(dataDir: string, protector: KeyProtector): Encryptor {
    const file = join(dataDir, KEY_FILE)
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile
      if (parsed.format !== 1) throw new Error('Unsupported vault key file')
      const blob = Buffer.from(parsed.key, 'base64')
      const key = parsed.protection === 'none' ? blob : protector.unprotect(blob)
      return Encryptor.forKey(key, parsed.keyVersion, parsed.protection)
    }
    const key = randomBytes(32)
    const body: KeyFile = {
      format: 1,
      protection: protector.name,
      keyVersion: 1,
      key: protector.protect(key).toString('base64')
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    renameSync(tmp, file)
    return Encryptor.forKey(key, 1, protector.name)
  }

  encrypt(plaintext: string, aad: string): Buffer {
    const nonce = randomBytes(NONCE_LEN)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([Buffer.from([FORMAT, this.keyVersion]), nonce, cipher.getAuthTag(), body])
  }

  decrypt(blob: Buffer, aad: string): string {
    if (blob.length < HEADER_LEN + NONCE_LEN + TAG_LEN || blob[0] !== FORMAT) {
      throw new Error('Unreadable encrypted value')
    }
    if (blob[1] !== this.keyVersion) throw new Error('Encrypted with an unknown key version')
    const nonce = blob.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN)
    const tag = blob.subarray(HEADER_LEN + NONCE_LEN, HEADER_LEN + NONCE_LEN + TAG_LEN)
    const body = blob.subarray(HEADER_LEN + NONCE_LEN + TAG_LEN)
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  }
}
