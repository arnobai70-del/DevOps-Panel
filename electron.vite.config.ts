import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
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
