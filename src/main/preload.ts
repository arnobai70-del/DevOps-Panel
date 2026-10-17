import { contextBridge, ipcRenderer } from 'electron'
import type { IpcResult, VaultAPI } from '../shared/types'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result.ok) throw new Error(result.error)
  return result.data
}

// The renderer only ever sees this narrow, typed surface: no fs, no SQLite, no raw ipcRenderer.
const api: VaultAPI = {
  app: {
    info: () => invoke('app:info')
  },
  projects: {
    list: (query) => invoke('projects:list', query),
    create: (input) => invoke('projects:create', input)
  }
}

contextBridge.exposeInMainWorld('vault', api)
