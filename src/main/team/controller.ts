import type { TeamStatus } from '../../shared/types'
import type { KeyProtector } from '../services/encryption'
import type { Vault } from '../services/vault'
import { hello, pairStart, pairStatus, TeamClient, type PinnedHost } from './client'
import { readTeamConfig, writeTeamConfig } from './config'
import { TeamHost } from './host'
import { normalizeCode, parseHostAddress, shortFingerprint } from './protocol'

type JoinState = PinnedHost & { hostName: string; startedAt: number }

const JOIN_FORGET_MS = 15 * 60 * 1000

/**
 * Owns this PC's team role: personal (local vault only), host (shares the local vault on the LAN)
 * or client (every vault operation runs on the paired host). No Electron imports, so it is testable.
 */
export class TeamController {
  host: TeamHost | null = null
  client: TeamClient | null = null
  private hostError: string | null = null
  private readonly joins = new Map<string, JoinState>()

  constructor(
    private readonly opts: {
      dataDir: string
      protector: KeyProtector
      getVault: () => Vault
      hostName: string
      /** Tests use port 0 on loopback; the app uses the default port on all interfaces. */
      port?: number
      bind?: string
    }
  ) {}

  get role(): TeamStatus['role'] {
    if (this.client) return 'client'
    if (this.host) return 'host'
    return 'personal'
  }

  /** Restores the role saved last time. A host that cannot start stays a host and reports why. */
  async init(): Promise<void> {
    const config = readTeamConfig(this.opts.dataDir)
    if (config.role === 'host') {
      await this.startHost()
    } else if (config.role === 'client') {
      try {
        const token = this.opts.protector.unprotect(Buffer.from(config.token, 'base64')).toString('utf8')
        this.client = new TeamClient(config.host, token)
      } catch {
        // The token cannot be unlocked (e.g. data copied from another Windows account): start over.
        writeTeamConfig(this.opts.dataDir, { role: 'personal' })
      }
    }
  }

  async status(): Promise<TeamStatus> {
    if (this.client) {
      const { host } = this.client
      const { online, error } = await this.client.ping()
      return {
        role: 'client',
        hostName: host.hostName,
        address: host.address,
        port: host.port,
        fingerprint: shortFingerprint(host.fingerprint),
        online,
        error
      }
    }
    if (this.host) {
      const host = this.host
      return {
        role: 'host',
        running: host.running,
        error: this.hostError,
        port: host.port,
        addresses: TeamHost.lanAddresses(),
        fingerprint: host.fingerprint ? shortFingerprint(host.fingerprint) : '',
        code: host.currentCode(),
        pending: host.pendingRequests(),
        devices: host.devices()
      }
    }
    return { role: 'personal' }
  }

  async enableHost(): Promise<TeamStatus> {
    if (this.client) throw new Error('This PC is joined to a team vault. Leave it before sharing this vault.')
    writeTeamConfig(this.opts.dataDir, { role: 'host' })
    await this.startHost()
    if (this.host?.running && !this.host.currentCode()) this.host.newCode()
    return this.status()
  }

  async disableHost(): Promise<TeamStatus> {
    writeTeamConfig(this.opts.dataDir, { role: 'personal' })
    await this.host?.stop()
    this.host = null
    this.hostError = null
    return this.status()
  }

  async newCode(): Promise<TeamStatus> {
    this.requireRunningHost().newCode()
    return this.status()
  }

  async approve(requestId: string): Promise<TeamStatus> {
    this.requireRunningHost().approve(requestId)
    return this.status()
  }

  async deny(requestId: string): Promise<TeamStatus> {
    this.requireRunningHost().deny(requestId)
    return this.status()
  }

  async revoke(deviceId: string): Promise<TeamStatus> {
    if (!this.host) throw new Error('Team sharing is off.')
    this.host.revoke(deviceId)
    return this.status()
  }

  async join(input: { address: string; code: string; deviceName: string }): Promise<{ requestId: string; hostName: string; fingerprint: string }> {
    if (this.host) throw new Error('This PC is sharing its own vault. Stop sharing before joining another one.')
    if (this.client) throw new Error('This PC is already joined to a team vault.')
    const code = normalizeCode(input.code)
    const deviceName = input.deviceName.trim().slice(0, 80)
    if (!deviceName) throw new Error('Enter a name for this PC.')
    const pinned = await hello(parseHostAddress(input.address))
    const requestId = await pairStart(pinned, code, deviceName)
    this.forgetStaleJoins()
    this.joins.set(requestId, { ...pinned, startedAt: Date.now() })
    return { requestId, hostName: pinned.hostName, fingerprint: shortFingerprint(pinned.fingerprint) }
  }

  async joinStatus(requestId: string): Promise<'pending' | 'approved' | 'denied' | 'expired'> {
    const pinned = this.joins.get(requestId)
    if (!pinned) return 'expired'
    const { status, token } = await pairStatus(pinned, requestId)
    if (status === 'pending') return 'pending'
    this.joins.delete(requestId)
    if (status === 'approved' && token) {
      const { startedAt: _startedAt, ...host } = pinned
      writeTeamConfig(this.opts.dataDir, {
        role: 'client',
        host,
        token: this.opts.protector.protect(Buffer.from(token, 'utf8')).toString('base64')
      })
      this.client = new TeamClient(host, token)
      return 'approved'
    }
    return status === 'denied' ? 'denied' : 'expired'
  }

  /** Back to the local vault on this PC. The host keeps the device listed until it is revoked there. */
  async leave(): Promise<TeamStatus> {
    writeTeamConfig(this.opts.dataDir, { role: 'personal' })
    this.client?.close()
    this.client = null
    return this.status()
  }

  async close(): Promise<void> {
    this.client?.close()
    await this.host?.stop()
  }

  private async startHost(): Promise<void> {
    this.host ??= new TeamHost({
      getVault: this.opts.getVault,
      dataDir: this.opts.dataDir,
      hostName: this.opts.hostName,
      port: this.opts.port,
      bind: this.opts.bind
    })
    try {
      await this.host.start()
      this.hostError = null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      this.hostError =
        code === 'EADDRINUSE'
          ? `Port ${this.host.port} is already in use on this PC. Close the other program using it and try again.`
          : `Team sharing could not start: ${err instanceof Error ? err.message : 'unknown error'}`
    }
  }

  private requireRunningHost(): TeamHost {
    if (!this.host?.running) throw new Error('Team sharing is not running.')
    return this.host
  }

  private forgetStaleJoins(): void {
    const cutoff = Date.now() - JOIN_FORGET_MS
    for (const [id, join] of this.joins) if (join.startedAt < cutoff) this.joins.delete(id)
  }
}
