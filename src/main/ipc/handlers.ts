import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { httpUrl } from '../../shared/schemas'
import type { AppInfo, BackupResult, DocumentSummary, IpcResult, RestoreResult } from '../../shared/types'
import { createBackup, inspectStaged, lastBackupAt, readBackup, swapInStaged } from '../services/backup'
import { executableRefusal, isExecutableName, safeFilename } from '../services/documents'
import type { KeyProtector } from '../services/encryption'
import { friendlyError } from '../services/errors'
import { Vault } from '../services/vault'
import type { TeamController } from '../team/controller'
import { str, vaultMethods } from './methods'

/** The open vault can be swapped out by a restore, so handlers always read it from here. */
export interface VaultContext {
  vault: Vault
  protector: KeyProtector
  team: TeamController
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const CLIPBOARD_CLEAR_MS = 30_000
const OPEN_DIR = join(tmpdir(), 'AgencyProjectVault-open')

const folderInput = z.string().min(1).max(1000)
const createFolderTeamInput = z.object({
  folder: folderInput,
  teamName: z.string().trim().max(100),
  passphrase: z.string().max(1024)
})
const joinFolderTeamInput = z.object({ folder: folderInput.optional(), passphrase: z.string().max(1024) })
// Calls that only read; anything else changed the vault and should reach teammates soon.
const READ_ONLY = /:(list|get|reveal|preview)$/

const joinInput = z.object({
  address: z.string().trim().min(1, 'Enter the host address').max(200),
  code: z.string().max(20),
  deviceName: z.string().max(80)
})

export function registerIpcHandlers(
  ctx: VaultContext,
  appInfo: () => AppInfo,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
): void {
  const handle = (channel: string, fn: Handler): void => {
    ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender' }
      try {
        return { ok: true, data: await fn(event, ...args) }
      } catch (err) {
        // Never echo inputs here: they may contain secrets.
        console.error(`[ipc] ${channel} failed:`, err instanceof Error ? err.name : 'unknown error')
        return { ok: false, error: friendlyError(err) }
      }
    })
  }
  const windowOf = (event: IpcMainInvokeEvent): BrowserWindow => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window')
    return win
  }

  handle('app:info', () => appInfo())
  handle('app:openExternal', async (_e, url) => {
    await shell.openExternal(httpUrl.parse(url))
  })

  // Plain vault operations run locally, or on the host PC when this PC has joined a team vault.
  const local = (): ReturnType<typeof vaultMethods> => vaultMethods(ctx.vault)
  const run = (method: string, ...args: unknown[]): Promise<unknown> | unknown => {
    const client = ctx.team.client
    if (client) return client.rpc(method, args)
    const result = local()[method]!(...args)
    if (!READ_ONLY.test(method)) ctx.team.noteLocalChange()
    return result
  }
  for (const channel of Object.keys(local())) {
    if (channel === 'documents:get') continue
    handle(channel, (_e, ...args) => run(channel, ...args))
  }

  const reveal = async (id: unknown, field: unknown): Promise<string> => String(await run('credentials:reveal', str(id), str(field)))
  const documentSummary = async (id: unknown): Promise<DocumentSummary> =>
    (await run('documents:get', str(id))) as DocumentSummary
  /** Copies a document to destPath, from the local vault or downloaded from the host. */
  const fetchDocument = async (id: string, destPath: string): Promise<void> => {
    const client = ctx.team.client
    if (client) await client.download(id, destPath)
    else await ctx.vault.documents.exportTo(id, destPath)
  }

  handle('credentials:copy', async (_e, id, field) => {
    const value = await reveal(id, field)
    await clipboard.writeText(value)
    // Best effort only: other apps (clipboard history, sync) may already have a copy.
    setTimeout(() => {
      void clipboard.readText().then((current) => {
        if (current === value) clipboard.clear()
      })
    }, CLIPBOARD_CLEAR_MS)
  })

  handle('documents:pickFile', async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), { title: 'Choose a document', properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    const client = ctx.team.client
    return client ? client.upload(result.filePaths[0]) : ctx.vault.documents.registerPick(result.filePaths[0])
  })
  handle('documents:export', async (event, id) => {
    const summary = await documentSummary(id)
    const result = await dialog.showSaveDialog(windowOf(event), {
      title: 'Export document',
      defaultPath: safeFilename(summary.originalFilename)
    })
    if (result.canceled || !result.filePath) return false
    await fetchDocument(summary.id, result.filePath)
    return true
  })
  handle('documents:openExternal', async (_e, id) => {
    const summary = await documentSummary(id)
    if (isExecutableName(summary.originalFilename)) throw new Error(executableRefusal(summary.originalFilename))
    const dir = join(OPEN_DIR, randomUUID())
    await mkdir(dir, { recursive: true })
    const path = join(dir, safeFilename(summary.originalFilename))
    await fetchDocument(summary.id, path)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })

  handle('team:status', () => ctx.team.status())
  handle('team:enableHost', () => ctx.team.enableHost())
  handle('team:disableHost', () => ctx.team.disableHost())
  handle('team:newCode', () => ctx.team.newCode())
  handle('team:approve', (_e, id) => ctx.team.approve(str(id)))
  handle('team:deny', (_e, id) => ctx.team.deny(str(id)))
  handle('team:revoke', (_e, id) => ctx.team.revoke(str(id)))
  handle('team:join', (_e, input) => ctx.team.join(joinInput.parse(input)))
  handle('team:joinStatus', (_e, id) => ctx.team.joinStatus(str(id)))
  handle('team:leave', () => ctx.team.leave())
  handle('team:chooseFolder', async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), {
      title: 'Choose the shared folder (e.g. inside Google Drive or OneDrive)',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
  handle('team:createFolderTeam', (_e, input) => ctx.team.createFolderTeam(createFolderTeamInput.parse(input)))
  handle('team:joinFolderTeam', (_e, input) => ctx.team.joinFolderTeam(joinFolderTeamInput.parse(input)))
  handle('team:syncNow', () => ctx.team.syncNow())
  handle('team:leaveFolder', () => ctx.team.leaveFolder())

  const localOnly = (): void => {
    if (ctx.team.client) throw new Error('Backups are made on the host PC, where the team vault is stored.')
  }

  let backupBusy = false
  const exclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (backupBusy) throw new Error('A backup or restore is already running.')
    backupBusy = true
    try {
      return await fn()
    } finally {
      backupBusy = false
    }
  }
  const passphraseArg = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 1024) throw new Error('Invalid passphrase')
    return value
  }

  handle('backups:status', () => {
    localOnly()
    return {
      lastBackupAt: lastBackupAt(ctx.vault.database),
      hasData: ctx.vault.projects.list({ includeArchived: true }).length > 0
    }
  })

  handle('backups:create', (event, passphrase) =>
    exclusive(async (): Promise<BackupResult | null> => {
      localOnly()
      const secret = passphraseArg(passphrase)
      const date = new Date().toISOString().slice(0, 10)
      const result = await dialog.showSaveDialog(windowOf(event), {
        title: 'Save encrypted backup',
        defaultPath: `AgencyProjectVault-backup-${date}.apv`,
        filters: [{ name: 'Agency Project Vault backup', extensions: ['apv'] }]
      })
      if (result.canceled || !result.filePath) return null
      const done = await createBackup({
        db: ctx.vault.database,
        dataDir: ctx.vault.dataDir,
        encryptor: ctx.vault.encryptor,
        destPath: result.filePath,
        passphrase: secret,
        appVersion: app.getVersion()
      })
      return { path: result.filePath, ...done }
    })
  )

  handle('backups:restore', (event, passphrase) =>
    exclusive(async (): Promise<RestoreResult | null> => {
      localOnly()
      if (ctx.team.role === 'folder') {
        throw new Error('This PC syncs with a team folder. Stop folder sync before restoring, or the restore would mix with the team data.')
      }
      const secret = passphraseArg(passphrase)
      const result = await dialog.showOpenDialog(windowOf(event), {
        title: 'Choose a backup to restore',
        properties: ['openFile'],
        filters: [{ name: 'Agency Project Vault backup', extensions: ['apv'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      const dataDir = ctx.vault.dataDir
      const stagingDir = join(dataDir, `.restore-${randomUUID()}`)
      try {
        // Decrypt and verify everything before the live vault is touched.
        const staged = await readBackup(result.filePaths[0], secret, stagingDir)
        const counts = inspectStaged(staged)
        ctx.vault.close()
        let safetyCopyDir: string
        try {
          safetyCopyDir = swapInStaged(dataDir, staged, ctx.protector)
        } finally {
          ctx.vault = Vault.open(dataDir, ctx.protector)
        }
        return { backupCreatedAt: staged.manifest.createdAt, counts, safetyCopyDir }
      } finally {
        await rm(stagingDir, { recursive: true, force: true })
      }
    })
  )
}
