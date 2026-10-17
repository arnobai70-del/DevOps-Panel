import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/** Everything the app writes lives under this subfolder of the folder the user picks. */
export const TEAM_DIR = 'AgencyProjectVault-Team'
const TEAM_FILE = 'team.json'
const KDF = { N: 2 ** 17, r: 8, p: 1 }
export const MIN_TEAM_PASSPHRASE = 10

const teamFileSchema = z.object({
  app: z.literal('agency-project-vault'),
  format: z.literal(1),
  teamId: z.string().uuid(),
  teamName: z.string().max(100),
  createdAt: z.string(),
  keyVersion: z.number().int().min(1).max(255),
  kdf: z.object({ N: z.number().int(), r: z.number().int(), p: z.number().int(), salt: z.string() }),
  /** Team key wrapped with AES-256-GCM under a key derived from the team passphrase. */
  wrappedKey: z.object({ nonce: z.string(), tag: z.string(), data: z.string() }),
  /** HMAC proving the passphrase is right before the unwrap is even attempted. */
  check: z.string()
})
type TeamFile = z.infer<typeof teamFileSchema>

export interface TeamInfo {
  teamId: string
  teamName: string
  keyVersion: number
  /** The shared vault key: credentials are encrypted with it on every PC in the team. */
  key: Buffer
}

export const teamDir = (folder: string): string => join(folder, TEAM_DIR)

function scrypt(passphrase: string, salt: Buffer, kdf: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(passphrase.normalize('NFC'), salt, 64, { ...kdf, maxmem: 256 * kdf.N * kdf.r }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  )
}

const checkOf = (checkKey: Buffer, teamId: string): Buffer => createHmac('sha256', checkKey).update(`team-check:${teamId}`).digest()

export function hasTeam(folder: string): boolean {
  return existsSync(join(teamDir(folder), TEAM_FILE))
}

/** Creates a team in folder, protecting the given key (this PC's vault key) with the passphrase. */
export async function createTeam(
  folder: string,
  opts: { teamName: string; passphrase: string; key: Buffer; keyVersion: number; teamId: string; now?: string }
): Promise<TeamInfo> {
  if (opts.passphrase.length < MIN_TEAM_PASSPHRASE) throw new Error(`Use a team passphrase of at least ${MIN_TEAM_PASSPHRASE} characters.`)
  const dir = teamDir(folder)
  if (hasTeam(folder)) throw new Error('This folder already has a team vault. Use Join instead.')
  mkdirSync(join(dir, 'records'), { recursive: true })
  mkdirSync(join(dir, 'files'), { recursive: true })
  const salt = randomBytes(16)
  const material = await scrypt(opts.passphrase, salt, KDF)
  const wrapKey = material.subarray(0, 32)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', wrapKey, nonce)
  cipher.setAAD(Buffer.from(`team-key:${opts.teamId}`))
  const data = Buffer.concat([cipher.update(opts.key), cipher.final()])
  const file: TeamFile = {
    app: 'agency-project-vault',
    format: 1,
    teamId: opts.teamId,
    teamName: opts.teamName.trim().slice(0, 100) || 'Team vault',
    createdAt: opts.now ?? new Date().toISOString(),
    keyVersion: opts.keyVersion,
    kdf: { ...KDF, salt: salt.toString('base64') },
    wrappedKey: { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') },
    check: checkOf(material.subarray(32), opts.teamId).toString('base64')
  }
  const path = join(dir, TEAM_FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(file, null, 2))
  renameSync(`${path}.tmp`, path)
  return { teamId: file.teamId, teamName: file.teamName, keyVersion: file.keyVersion, key: Buffer.from(opts.key) }
}

/** Reads the team in folder and unlocks its key with the passphrase. */
export async function openTeam(folder: string, passphrase: string): Promise<TeamInfo> {
  const path = join(teamDir(folder), TEAM_FILE)
  if (!existsSync(path)) throw new Error('No team vault found in this folder. Pick the folder the team was created in.')
  let file: TeamFile
  try {
    file = teamFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    throw new Error('The team file in this folder is damaged or from a newer app version.')
  }
  const material = await scrypt(passphrase, Buffer.from(file.kdf.salt, 'base64'), file.kdf)
  const expected = Buffer.from(file.check, 'base64')
  const actual = checkOf(material.subarray(32), file.teamId)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('Wrong team passphrase.')
  const decipher = createDecipheriv('aes-256-gcm', material.subarray(0, 32), Buffer.from(file.wrappedKey.nonce, 'base64'))
  decipher.setAAD(Buffer.from(`team-key:${file.teamId}`))
  decipher.setAuthTag(Buffer.from(file.wrappedKey.tag, 'base64'))
  const key = Buffer.concat([decipher.update(Buffer.from(file.wrappedKey.data, 'base64')), decipher.final()])
  return { teamId: file.teamId, teamName: file.teamName, keyVersion: file.keyVersion, key }
}

/** Team id and name without the passphrase, to check the folder still holds the same team. */
export function peekTeam(folder: string): { teamId: string; teamName: string } | null {
  try {
    const file = teamFileSchema.parse(JSON.parse(readFileSync(join(teamDir(folder), TEAM_FILE), 'utf8')))
    return { teamId: file.teamId, teamName: file.teamName }
  } catch {
    return null
  }
}
