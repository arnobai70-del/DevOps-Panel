import { app, BrowserWindow, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unprotectedKeys, type KeyProtector } from './services/encryption'
import { Vault } from './services/vault'
import { registerIpcHandlers, type VaultContext } from './ipc/handlers'
import { TeamController } from './team/controller'

// Keep data in %APPDATA%\AgencyProjectVault rather than a folder named after the display name.
app.setPath('userData', join(app.getPath('appData'), 'AgencyProjectVault'))

const devServerUrl = process.env['ELECTRON_RENDERER_URL']
const rendererFile = join(__dirname, '../renderer/index.html')
const rendererOrigin = devServerUrl ? new URL(devServerUrl).origin : null

function isAppUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (rendererOrigin) return url.origin === rendererOrigin
    return url.protocol === 'file:' && url.pathname === pathToFileURL(rendererFile).pathname
  } catch {
    return false
  }
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  return !!event.senderFrame && isAppUrl(event.senderFrame.url)
}

/** Windows DPAPI (via safeStorage) protects the vault key; falls back to an unprotected key where the OS offers none. */
function keyProtector(): KeyProtector {
  if (!safeStorage.isEncryptionAvailable()) return unprotectedKeys
  return {
    name: 'safeStorage',
    protect: (key) => safeStorage.encryptString(key.toString('base64')),
    unprotect: (blob) => Buffer.from(safeStorage.decryptString(blob), 'base64')
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Agency Project Vault',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged
    }
  })

  win.once('ready-to-show', () => win.show())

  // Never navigate away from the packaged UI; open plain web links in the system browser instead.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (devServerUrl) void win.loadURL(devServerUrl)
  else void win.loadFile(rendererFile)
}

if (!app.requestSingleInstanceLock()) {
  // Only one process may write the vault database at a time.
  app.quit()
} else {
  let ctx: VaultContext | null = null

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    const protector = keyProtector()
    const dataDir = app.getPath('userData')
    const vault = Vault.open(dataDir, protector)
    const opened: VaultContext = {
      vault,
      protector,
      team: new TeamController({
        dataDir,
        protector,
        getVault: () => opened.vault,
        hostName: hostname(),
        reopenVault: () => {
          opened.vault.close()
          opened.vault = Vault.open(dataDir, protector)
        },
        onRemoteChange: () => {
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('vault:remote-change')
        }
      })
    }
    ctx = opened
    opened.vault.documents.cleanupOrphans().catch((err: unknown) => {
      console.error('[startup] orphan cleanup failed:', err instanceof Error ? err.message : err)
    })
    await opened.team.init()
    registerIpcHandlers(
      opened,
      () => ({
        version: app.getVersion(),
        dataDir: opened.vault.dataDir,
        mode: opened.team.role,
        keyProtection: opened.vault.encryptor.protection
      }),
      isTrustedSender
    )
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => {
    if (!ctx) return
    void ctx.team.close()
    ctx.vault.close()
    ctx = null
  })
}
