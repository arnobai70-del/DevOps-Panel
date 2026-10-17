import type { Vault } from '../services/vault'

export const str = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid argument')
  return value
}

type Method = (...args: unknown[]) => unknown

/**
 * Vault operations that need no OS dialog, clipboard or shell. The local IPC handlers and the
 * team host both dispatch through this one table, so a joined PC gets exactly the same behaviour
 * (and validation) as the host itself. Anything not listed here is not reachable over the LAN.
 */
export function vaultMethods(vault: Vault): Record<string, Method> {
  return {
    'projects:list': (query) => vault.projects.list((query ?? {}) as never),
    'projects:get': (id) => vault.projects.require(str(id)),
    'projects:create': (input) => vault.projects.create(input as never),
    'projects:update': (update) => vault.projects.update(update as never),
    'projects:archive': (id) => vault.projects.archive(str(id)),
    'projects:restore': (id) => vault.projects.restore(str(id)),

    'credentials:list': (projectId) => vault.credentials.list(str(projectId)),
    'credentials:save': (input) => vault.credentials.save(input as never),
    'credentials:reveal': (id, field) => vault.credentials.reveal(str(id), str(field) as never),
    'credentials:remove': (id) => vault.credentials.remove(str(id)),

    'documents:list': (projectId) => vault.documents.list(str(projectId)),
    'documents:get': (id) => vault.documents.get(str(id)),
    'documents:create': (input) => vault.documents.create(input as never),
    'documents:update': (input) => vault.documents.update(input as never),
    'documents:preview': (id) => vault.documents.preview(str(id)),
    'documents:remove': (id) => vault.documents.remove(str(id)),

    'notes:list': (projectId) => vault.notes.list(str(projectId)),
    'notes:save': (input) => vault.notes.save(input as never),
    'notes:remove': (id) => vault.notes.remove(str(id)),

    'links:list': (projectId) => vault.links.list(str(projectId)),
    'links:save': (input) => vault.links.save(input as never),
    'links:remove': (id) => vault.links.remove(str(id))
  }
}
