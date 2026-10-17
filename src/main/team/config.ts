import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Which kind of vault this PC runs. Kept outside the database so a restore never changes it,
 * and so a joined PC knows where its data lives before it opens anything.
 */
export type TeamConfig =
  | { role: 'personal' }
  | { role: 'host' }
  | {
      role: 'client'
      host: { address: string; port: number; certPem: string; fingerprint: string; hostName: string }
      /** Device token, protected with the same OS key protection as the vault key (base64). */
      token: string
    }
  | {
      role: 'folder'
      /** The shared folder the user picked (e.g. inside Google Drive or OneDrive). */
      folder: string
      teamId: string
      teamName: string
      /** Random id of this PC, written into every record it syncs. */
      deviceId: string
    }

const configSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('personal') }),
  z.object({ role: z.literal('host') }),
  z.object({
    role: z.literal('client'),
    host: z.object({
      address: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      certPem: z.string().min(1),
      fingerprint: z.string().min(1),
      hostName: z.string()
    }),
    token: z.string().min(1)
  }),
  z.object({
    role: z.literal('folder'),
    folder: z.string().min(1),
    teamId: z.string().uuid(),
    teamName: z.string(),
    deviceId: z.string().min(1)
  })
])

const configPath = (dataDir: string): string => join(dataDir, 'team', 'config.json')

export function readTeamConfig(dataDir: string): TeamConfig {
  try {
    return configSchema.parse(JSON.parse(readFileSync(configPath(dataDir), 'utf8')))
  } catch {
    return { role: 'personal' }
  }
}

export function writeTeamConfig(dataDir: string, config: TeamConfig): void {
  const path = configPath(dataDir)
  mkdirSync(join(dataDir, 'team'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}
