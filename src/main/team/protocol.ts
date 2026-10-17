import { createHmac, randomBytes, randomInt, X509Certificate } from 'node:crypto'

export const TEAM_PORT = 47321
export const PAIRING_TTL_MS = 10 * 60 * 1000
export const PAIRING_MAX_ATTEMPTS = 5

// Crockford base32 without I, L, O, U: easy to read aloud and type.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 8 characters (40 bits), shown as XXXX-XXXX. Short-lived and limited to a few attempts. */
export function newPairingCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/**
 * Proof that the sender knows the pairing code, bound to the certificate the client actually saw.
 * A man in the middle presents a different certificate, so the host's proof check fails, and it
 * cannot forge the host's proof without the code.
 */
export function pairingProof(code: string, role: 'client' | 'host', fingerprint: string, nonce: string): string {
  return createHmac('sha256', normalizeCode(code)).update(`${role}|${fingerprint}|${nonce}`).digest('hex')
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function newNonce(): string {
  return randomBytes(16).toString('hex')
}

export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256
}

/** Short, human-comparable form of a certificate fingerprint. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, '').slice(0, 16).match(/.{4}/g)!.join(' ')
}

/** Only loopback, private (RFC 1918 / ULA) and link-local addresses may talk to the host. */
export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false
  const addr = address.toLowerCase().replace(/^::ffff:/, '')
  const v4 = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return addr === '::1' || /^fe[89ab][0-9a-f]:/.test(addr) || /^f[cd][0-9a-f]{2}:/.test(addr)
}

/** Accepts "192.168.1.20", "192.168.1.20:47321" or a host name. */
export function parseHostAddress(input: string): { address: string; port: number } {
  const trimmed = input.trim()
  const match = trimmed.match(/^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/)
  if (!match || !match[1] || /[\s/]/.test(match[1])) throw new Error('Enter the host address shown on the host PC, e.g. 192.168.1.20')
  const port = match[2] ? Number(match[2]) : TEAM_PORT
  if (port < 1 || port > 65535) throw new Error('Invalid port')
  return { address: match[1], port }
}
