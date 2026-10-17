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
    info: () => invoke('app:info'),
    openExternal: (url) => invoke('app:openExternal', url)
  },
  projects: {
    list: (query) => invoke('projects:list', query),
    get: (id) => invoke('projects:get', id),
    create: (input) => invoke('projects:create', input),
    update: (update) => invoke('projects:update', update),
    archive: (id) => invoke('projects:archive', id),
    restore: (id) => invoke('projects:restore', id)
  },
  credentials: {
    list: (projectId) => invoke('credentials:list', projectId),
    save: (input) => invoke('credentials:save', input),
    reveal: (id, field) => invoke('credentials:reveal', id, field),
    copy: (id, field) => invoke('credentials:copy', id, field),
    remove: (id) => invoke('credentials:remove', id)
  },
  documents: {
    list: (projectId) => invoke('documents:list', projectId),
    pickFile: () => invoke('documents:pickFile'),
    create: (input) => invoke('documents:create', input),
    update: (input) => invoke('documents:update', input),
    preview: (id) => invoke('documents:preview', id),
    exportFile: (id) => invoke('documents:export', id),
    openExternal: (id) => invoke('documents:openExternal', id),
    remove: (id) => invoke('documents:remove', id)
  },
  notes: {
    list: (projectId) => invoke('notes:list', projectId),
    save: (input) => invoke('notes:save', input),
    remove: (id) => invoke('notes:remove', id)
  },
  links: {
    list: (projectId) => invoke('links:list', projectId),
    save: (input) => invoke('links:save', input),
    remove: (id) => invoke('links:remove', id)
  }
}

contextBridge.exposeInMainWorld('vault', api)
