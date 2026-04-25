import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from './sessionManager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DEV = !app.isPackaged
const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? 'http://localhost:5174'

// Expose CDP in dev so the Claude electron skill / agent-browser can attach.
if (DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let mainWindow: BrowserWindow | null = null
const manager = new SessionManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0b10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined)
    return { action: 'deny' }
  })

  manager.bindWebContents(mainWindow.webContents)

  if (DEV) {
    mainWindow.loadURL(DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await manager.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await manager.closeAll()
})

function registerIpc(): void {
  ipcMain.handle('tabs:list', () => manager.listTabs())

  ipcMain.handle('tabs:create', async (_e, input: { workDir: string; selectedModel?: string; selectedAgent?: string }) => {
    return manager.createTab(input)
  })

  ipcMain.handle('tabs:close', async (_e, tabId: string) => {
    await manager.closeTab(tabId)
  })

  ipcMain.handle('rpc:request', async (_e, args: { tabId: string; method: string; params?: unknown }) => {
    return manager.request(args.tabId, args.method, args.params)
  })

  ipcMain.handle('workspace:pickDirectory', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a workspace directory',
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('theme:getSystem', () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))
  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:systemChanged', nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })
}
