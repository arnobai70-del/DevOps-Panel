import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { httpUrl } from '../../shared/schemas'
import type { AppInfo, IpcResult } from '../../shared/types'
import { safeFilename } from '../services/documents'
import type { Vault } from '../services/vault'

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
  vault: Vault,
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

  handle('projects:list', (_e, query) => vault.projects.list((query ?? {}) as never))
  handle('projects:get', (_e, id) => vault.projects.require(str(id)))
  handle('projects:create', (_e, input) => vault.projects.create(input as never))
  handle('projects:update', (_e, update) => vault.projects.update(update as never))
  handle('projects:archive', (_e, id) => vault.projects.archive(str(id)))
  handle('projects:restore', (_e, id) => vault.projects.restore(str(id)))

  handle('credentials:list', (_e, projectId) => vault.credentials.list(str(projectId)))
  handle('credentials:save', (_e, input) => vault.credentials.save(input as never))
  handle('credentials:reveal', (_e, id, field) => vault.credentials.reveal(str(id), str(field) as never))
  handle('credentials:copy', async (_e, id, field) => {
    const value = vault.credentials.reveal(str(id), str(field) as never)
    await clipboard.writeText(value)
    // Best effort only: other apps (clipboard history, sync) may already have a copy.
    setTimeout(() => {
      void clipboard.readText().then((current) => {
        if (current === value) clipboard.clear()
      })
    }, CLIPBOARD_CLEAR_MS)
  })
  handle('credentials:remove', (_e, id) => vault.credentials.remove(str(id)))

  handle('documents:list', (_e, projectId) => vault.documents.list(str(projectId)))
  handle('documents:pickFile', async (event) => {
    const result = await dialog.showOpenDialog(windowOf(event), { title: 'Choose a document', properties: ['openFile'] })
    if (result.canceled || !result.filePaths[0]) return null
    return vault.documents.registerPick(result.filePaths[0])
  })
  handle('documents:create', (_e, input) => vault.documents.create(input as never))
  handle('documents:update', (_e, input) => vault.documents.update(input as never))
  handle('documents:preview', (_e, id) => vault.documents.preview(str(id)))
  handle('documents:export', async (event, id) => {
    const summary = vault.documents.get(str(id))
    const result = await dialog.showSaveDialog(windowOf(event), {
      title: 'Export document',
      defaultPath: safeFilename(summary.originalFilename)
    })
    if (result.canceled || !result.filePath) return false
    await vault.documents.exportTo(summary.id, result.filePath)
    return true
  })
  handle('documents:openExternal', async (_e, id) => {
    const path = await vault.documents.prepareOpen(str(id), join(tmpdir(), 'AgencyProjectVault-open'))
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handle('documents:remove', (_e, id) => vault.documents.remove(str(id)))

  handle('notes:list', (_e, projectId) => vault.notes.list(str(projectId)))
  handle('notes:save', (_e, input) => vault.notes.save(input as never))
  handle('notes:remove', (_e, id) => vault.notes.remove(str(id)))

  handle('links:list', (_e, projectId) => vault.links.list(str(projectId)))
  handle('links:save', (_e, input) => vault.links.save(input as never))
  handle('links:remove', (_e, id) => vault.links.remove(str(id)))
}
