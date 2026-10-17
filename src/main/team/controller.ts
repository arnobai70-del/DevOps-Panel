import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamStatus } from '../../shared/types'
import { Encryptor, type KeyProtector } from '../services/encryption'
import type { Vault } from '../services/vault'
import { FolderSync } from '../sync/folderSync'
import { rekeyCredentials } from '../sync/rekey'
import { createTeam, findTeamFolders, hasTeam, openTeam, peekTeam, type TeamInfo } from '../sync/teamFolder'
import { hello, pairStart, pairStatus, TeamClient, type PinnedHost } from './client'
import { readTeamConfig, writeTeamConfig } from './config'
import { TeamHost } from './host'
import { normalizeCode, parseHostAddress, shortFingerprint } from './protocol'

type JoinState = PinnedHost & { hostName: string; startedAt: number }

const JOIN_FORGET_MS = 15 * 60 * 1000
const SYNC_INTERVAL_MS = 15_000
const SYNC_AFTER_CHANGE_MS = 1_500

interface FolderState {
  folder: string
  teamId: string
  teamName: string
  deviceId: string
  sync: FolderSync
  lastSyncAt: string | null
  error: string | null
  pending: number
}

/**
 * Owns this PC's team role: personal (local vault only), host (shares the local vault on the LAN),
 * client (every vault operation runs on the paired host) or folder (the local vault syncs through a
 * shared cloud folder; no PC has to stay on). No Electron imports, so it is testable.
 */
export class TeamController {
  host: TeamHost | null = null
  client: TeamClient | null = null
  private hostError: string | null = null
  private readonly joins = new Map<string, JoinState>()
  private folderState: FolderState | null = null
  private syncTimer: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly opts: {
      dataDir: string
      protector: KeyProtector
      getVault: () => Vault
      hostName: string
      /** Tests use port 0 on loopback; the app uses the default port on all interfaces. */
      port?: number
      bind?: string
      /** Re-opens the vault after its key file changed (joining a folder team). */
      reopenVault?: () => void
      /** Called after a sync brought in changes from other PCs. */
      onRemoteChange?: () => void
      syncIntervalMs?: number
      /** Where to look for team folders; defaults to the usual Google Drive / OneDrive / Dropbox places. */
      searchRoots?: string[]
    }
  ) {}

  get role(): TeamStatus['role'] {
    if (this.folderState) return 'folder'
    if (this.client) return 'client'
    if (this.host) return 'host'
    return 'personal'
  }

  /** Restores the role saved last time. A host that cannot start stays a host and reports why. */
  async init(): Promise<void> {
    const config = readTeamConfig(this.opts.dataDir)
    if (config.role === 'host') {
      await this.startHost()
    } else if (config.role === 'folder') {
      this.startFolder(config.folder, config.teamId, config.teamName, config.deviceId)
      if (peekTeam(config.folder)?.teamId !== config.teamId && existsSync(config.folder)) {
        this.folderState!.error = 'The team folder now holds a different team. Leave and join again.'
        this.stopTimers()
      } else {
        void this.runSync()
      }
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
    if (this.folderState) {
      const f = this.folderState
      return { role: 'folder', folder: f.folder, teamName: f.teamName, lastSyncAt: f.lastSyncAt, error: f.error, pending: f.pending }
    }
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
    this.refuseIfFolder()
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
    this.refuseIfFolder()
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

  // ---- shared cloud folder ----

  /** Starts a team in folder with this PC's vault and key; the passphrase lets other PCs join. */
  async createFolderTeam(input: { folder: string; teamName: string; passphrase: string }): Promise<TeamStatus> {
    this.refuseIfOtherRole()
    const vault = this.opts.getVault()
    const teamId = randomUUID()
    const team = await createTeam(input.folder, {
      teamName: input.teamName,
      passphrase: input.passphrase,
      key: vault.encryptor.exportKey(),
      keyVersion: vault.encryptor.keyVersion,
      teamId
    })
    return this.enterFolder(input.folder, team.teamId, team.teamName)
  }

  /**
   * Joins the team in folder. This PC adopts the team key (its own credentials are re-encrypted
   * with it, and the old key file is kept as vault.key.before-team), then its data merges in.
   */
  async joinFolderTeam(input: { folder?: string; passphrase: string }): Promise<TeamStatus> {
    this.refuseIfOtherRole()
    let folder: string
    let team: TeamInfo
    if (input.folder) {
      if (!hasTeam(input.folder)) throw new Error('No team vault found in this folder. Pick the folder the team was created in.')
      folder = input.folder
      team = await openTeam(folder, input.passphrase)
    } else {
      ;({ folder, team } = await this.findTeam(input.passphrase))
    }
    const vault = this.opts.getVault()
    if (!vault.encryptor.exportKey().equals(team.key) || vault.encryptor.keyVersion !== team.keyVersion) {
      const keyFile = join(this.opts.dataDir, 'vault.key')
      if (existsSync(keyFile)) copyFileSync(keyFile, `${keyFile}.before-team`)
      rekeyCredentials(vault.database, vault.encryptor, Encryptor.forKey(team.key, team.keyVersion))
      Encryptor.writeKeyFile(this.opts.dataDir, team.key, team.keyVersion, this.opts.protector)
      if (!this.opts.reopenVault) throw new Error('Cannot switch the vault key here')
      this.opts.reopenVault()
    }
    return this.enterFolder(folder, team.teamId, team.teamName)
  }

  /** Finds the team folder on this PC (Google Drive, OneDrive, Dropbox) that the passphrase opens. */
  private async findTeam(passphrase: string): Promise<{ folder: string; team: TeamInfo }> {
    const folders = await findTeamFolders(this.opts.searchRoots)
    if (folders.length === 0) {
      throw new Error(
        'No team folder found on this PC. Install Google Drive for desktop, sign in, and add the shared team folder to My Drive (in Drive: right-click the folder → Organize → Add shortcut). Then try again.'
      )
    }
    const tried = new Set<string>()
    for (const folder of folders) {
      const teamId = peekTeam(folder)?.teamId
      if (!teamId || tried.has(teamId)) continue
      tried.add(teamId)
      try {
        return { folder, team: await openTeam(folder, passphrase) }
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'Wrong team passphrase.') throw err
      }
    }
    throw new Error('Wrong team passphrase.')
  }

  /** Runs a sync round now and returns the new status. */
  async syncNow(): Promise<TeamStatus> {
    if (!this.folderState) throw new Error('Folder sync is off.')
    await this.runSync()
    return this.status()
  }

  /** Stops syncing. This PC keeps its copy of the team data. */
  async leaveFolder(): Promise<TeamStatus> {
    this.stopTimers()
    this.folderState = null
    writeTeamConfig(this.opts.dataDir, { role: 'personal' })
    return this.status()
  }

  /** Called after any local change; syncs shortly after, so teammates see it quickly. */
  noteLocalChange(): void {
    if (!this.folderState || this.syncTimer === null) return
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => void this.runSync(), SYNC_AFTER_CHANGE_MS)
  }

  private async enterFolder(folder: string, teamId: string, teamName: string): Promise<TeamStatus> {
    const deviceId = randomUUID()
    // A fresh team: forget what this vault may have synced with any earlier team folder.
    this.opts.getVault().database.prepare('DELETE FROM sync_state').run()
    writeTeamConfig(this.opts.dataDir, { role: 'folder', folder, teamId, teamName, deviceId })
    this.startFolder(folder, teamId, teamName, deviceId)
    await this.runSync()
    return this.status()
  }

  private startFolder(folder: string, teamId: string, teamName: string, deviceId: string): void {
    const vault = (): Vault => this.opts.getVault()
    const sync = new FolderSync({
      folder,
      teamKey: vault().encryptor.exportKey(),
      deviceId,
      db: () => vault().database,
      filesDir: () => join(vault().dataDir, 'files')
    })
    this.folderState = { folder, teamId, teamName, deviceId, sync, lastSyncAt: null, error: null, pending: 0 }
    this.syncTimer = setInterval(() => void this.runSync(), this.opts.syncIntervalMs ?? SYNC_INTERVAL_MS)
    this.syncTimer.unref?.()
  }

  private async runSync(): Promise<void> {
    const state = this.folderState
    if (!state) return
    try {
      const result = await state.sync.sync()
      state.lastSyncAt = new Date().toISOString()
      state.error = null
      state.pending = result.pending
      if (result.imported > 0) this.opts.onRemoteChange?.()
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Sync failed'
      if (!hasTeam(state.folder)) await this.relocate(state)
    }
  }

  /** The team folder moved (e.g. Google Drive got another drive letter): find it again by team id. */
  private async relocate(state: FolderState): Promise<void> {
    const moved = (await findTeamFolders(this.opts.searchRoots)).find((f) => peekTeam(f)?.teamId === state.teamId)
    if (!moved || this.folderState !== state) return
    writeTeamConfig(this.opts.dataDir, { role: 'folder', folder: moved, teamId: state.teamId, teamName: state.teamName, deviceId: state.deviceId })
    this.stopTimers()
    this.startFolder(moved, state.teamId, state.teamName, state.deviceId)
    await this.runSync()
  }

  private stopTimers(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.changeTimer) clearTimeout(this.changeTimer)
    this.syncTimer = null
    this.changeTimer = null
  }

  private refuseIfFolder(): void {
    if (this.folderState) throw new Error('This PC syncs through a team folder. Stop folder sync first.')
  }

  private refuseIfOtherRole(): void {
    if (this.folderState) throw new Error('This PC already syncs with a team folder.')
    if (this.host) throw new Error('This PC is sharing its vault on the office network. Stop sharing first.')
    if (this.client) throw new Error('This PC is joined to a team vault on the office network. Leave it first.')
  }

  async close(): Promise<void> {
    // Changes not yet synced go out on the next start.
    this.stopTimers()
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
