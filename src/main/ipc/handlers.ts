import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { httpUrl } from '../../shared/schemas'
import type { AppInfo, BackupResult, IpcResult, RestoreResult } from '../../shared/types'
import { createBackup, inspectStaged, lastBackupAt, readBackup, swapInStaged } from '../services/backup'
import { safeFilename } from '../services/documents'
import type { KeyProtector } from '../services/encryption'
import { Vault } from '../services/vault'

/** The open vault can be swapped out by a restore, so handlers always read it from here. */
export interface VaultContext {
  vault: Vault
  protector: KeyProtector
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const CLIPBOARD_CLEAR_MS = 30_000

function friendlyError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
  }
  if (err instanceof Error) return err.message
  return 'Unexpected error'
}

const str = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid argument')
  return value
}

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

  handle('projects:list', (_e, query) => ctx.vault.projects.list((query ?? {}) as never))
  handle('projects:get', (_e, id) => ctx.vault.projects.require(str(id)))
  handle('projects:create', (_e, input) => ctx.vault.projects.create(input as never))
  handle('projects:update', (_e, update) => ctx.vault.projects.update(update as never))
  handle('projects:archive', (_e, id) => ctx.vault.projects.archive(str(id)))
  handle('projects:restore', (_e, id) => ctx.vault.projects.restore(str(id)))

  handle('credentials:list', (_e, projectId) => ctx.vault.credentials.list(str(projectId)))
  handle('credentials:save', (_e, input) => ctx.vault.credentials.save(input as never))
  handle('credentials:reveal', (_e, id, field) => ctx.vault.credentials.reveal(str(id), str(field) as never))
  handle('credentials:copy', async (_e, id, field) => {
    const value = ctx.vault.credentials.reveal(str(id), str(field) as never)
    await clipboard.writeText(value)
    // Best effort only: other apps (clipboard history, sync) may already have a copy.
    setTimeout(() => {
      void clipboard.readText().then((current) => {
        if (current === value) clipboard.clear()
      })
    }, CLIPBOARD_CLEAR_MS)
  })
  handle('credentials:remove', (_e, id) => ctx.vault.credentials.remove(str(id)))

  handle('documents:list', (_e, projectId) => ctx.vault.documents.list(str(projectId)))
  handle('documents:pickFile', async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), { title: 'Choose a document', properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    return ctx.vault.documents.registerPick(result.filePaths[0])
  })
  handle('documents:create', (_e, input) => ctx.vault.documents.create(input as never))
  handle('documents:update', (_e, input) => ctx.vault.documents.update(input as never))
  handle('documents:preview', (_e, id) => ctx.vault.documents.preview(str(id)))
  handle('documents:export', async (event, id) => {
    const summary = ctx.vault.documents.get(str(id))
    const result = await dialog.showSaveDialog(windowOf(event), {
      title: 'Export document',
      defaultPath: safeFilename(summary.originalFilename)
    })
    if (result.canceled || !result.filePath) return false
    await ctx.vault.documents.exportTo(summary.id, result.filePath)
    return true
  })
  handle('documents:openExternal', async (_e, id) => {
    const path = await ctx.vault.documents.prepareOpen(str(id), join(tmpdir(), 'AgencyProjectVault-open'))
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handle('documents:remove', (_e, id) => ctx.vault.documents.remove(str(id)))

  handle('notes:list', (_e, projectId) => ctx.vault.notes.list(str(projectId)))
  handle('notes:save', (_e, input) => ctx.vault.notes.save(input as never))
  handle('notes:remove', (_e, id) => ctx.vault.notes.remove(str(id)))

  handle('links:list', (_e, projectId) => ctx.vault.links.list(str(projectId)))
  handle('links:save', (_e, input) => ctx.vault.links.save(input as never))
  handle('links:remove', (_e, id) => ctx.vault.links.remove(str(id)))

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

  handle('backups:status', () => ({
    lastBackupAt: lastBackupAt(ctx.vault.database),
    hasData: ctx.vault.projects.list({ includeArchived: true }).length > 0
  }))

  handle('backups:create', (event, passphrase) =>
    exclusive(async (): Promise<BackupResult | null> => {
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
