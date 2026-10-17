import { app, BrowserWindow, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Vault } from './services/vault'
import { registerIpcHandlers } from './ipc/handlers'

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
  let vault: Vault | null = null

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  void app.whenReady().then(() => {
    vault = Vault.open(app.getPath('userData'))
    const opened = vault
    registerIpcHandlers(
      opened,
      () => ({ version: app.getVersion(), dataDir: opened.dataDir, mode: 'personal' }),
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
    vault?.close()
    vault = null
  })
}
