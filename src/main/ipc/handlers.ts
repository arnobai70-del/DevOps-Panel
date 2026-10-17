import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { ZodError } from 'zod'
import type { Vault } from '../services/vault'
import type { AppInfo, IpcResult } from '../../shared/types'

type Handler = (...args: unknown[]) => unknown

function friendlyError(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ')
  }
  if (err instanceof Error) return err.message
  return 'Unexpected error'
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
        return { ok: true, data: await fn(...args) }
      } catch (err) {
        // Never echo inputs here: they may contain secrets.
        console.error(`[ipc] ${channel} failed:`, err instanceof Error ? err.message : 'unknown error')
        return { ok: false, error: friendlyError(err) }
      }
    })
  }

  handle('app:info', () => appInfo())
  handle('projects:list', (query) => vault.projects.list((query ?? {}) as never))
  handle('projects:create', (input) => vault.projects.create(input as never))
}
