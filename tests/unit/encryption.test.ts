import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Encryptor, unprotectedKeys, type KeyProtector } from '../../src/main/services/encryption'

const dirs: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'apv-key-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('Encryptor', () => {
  const enc = Encryptor.forKey(randomBytes(32))

  it('round-trips and uses a fresh nonce every time', () => {
    const a = enc.encrypt('s3cret-pass', 'credential:1:secrets')
    const b = enc.encrypt('s3cret-pass', 'credential:1:secrets')
    expect(a.equals(b)).toBe(false)
    expect(a.includes(Buffer.from('s3cret-pass'))).toBe(false)
    expect(enc.decrypt(a, 'credential:1:secrets')).toBe('s3cret-pass')
  })

  it('rejects tampering, the wrong AAD and the wrong key', () => {
    const blob = enc.encrypt('value', 'aad-1')
    expect(() => enc.decrypt(blob, 'aad-2')).toThrow()
    const tampered = Buffer.from(blob)
    tampered[tampered.length - 1]! ^= 1
    expect(() => enc.decrypt(tampered, 'aad-1')).toThrow()
    expect(() => Encryptor.forKey(randomBytes(32)).decrypt(blob, 'aad-1')).toThrow()
    expect(() => enc.decrypt(Buffer.from([1, 1, 2]), 'aad-1')).toThrow(/Unreadable/)
  })

  it('creates the key once, protects it, and reloads the same key', () => {
    const dir = tempDir()
    const xor: KeyProtector = {
      name: 'safeStorage',
      protect: (k) => Buffer.from(k.map((b) => b ^ 0xaa)),
      unprotect: (k) => Buffer.from(k.map((b) => b ^ 0xaa))
    }
    const first = Encryptor.loadOrCreate(dir, xor)
    const blob = first.encrypt('hello', 'x')
    const file = JSON.parse(readFileSync(join(dir, 'vault.key'), 'utf8'))
    expect(file.protection).toBe('safeStorage')
    const second = Encryptor.loadOrCreate(dir, xor)
    expect(second.decrypt(blob, 'x')).toBe('hello')
    expect(second.protection).toBe('safeStorage')
  })

  it('works without OS protection and says so', () => {
    const dir = tempDir()
    const e = Encryptor.loadOrCreate(dir, unprotectedKeys)
    expect(e.protection).toBe('none')
    expect(Encryptor.loadOrCreate(dir, unprotectedKeys).decrypt(e.encrypt('v', 'a'), 'a')).toBe('v')
  })
})
