import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // The Google OAuth client is built in from GitHub Actions secrets, never from the source code.
    define: {
      __APV_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_OAUTH_CLIENT_ID ?? ''),
      __APV_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '')
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/preload.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    },
    plugins: [react()]
  }
})
