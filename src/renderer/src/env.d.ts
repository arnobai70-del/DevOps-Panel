import type { VaultAPI } from '../../shared/types'

declare global {
  interface Window {
    vault: VaultAPI
  }
}

export {}
