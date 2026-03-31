import { app, shell, BrowserWindow, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { initSystemDb, registerUser, loginUser } from './auth'
import {
  initDB,
  listApps,
  searchApps,
  createApp,
  updateCredential,
  deleteApp,
  clearMasterKey,
  closeVault,
  getHistory,
  setMasterPassword
} from './db'
import { initBridgeServer } from './bridge'

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon: join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  initBridgeServer(mainWindow.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initSystemDb()

  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('auth:register', async (_event, username, password) => {
    const res = registerUser(username, password)
    if (res.success) {
      initDB(res.dbFilename)
      setMasterPassword(password, res.salt)
    }
    return res
  })

  ipcMain.handle('auth:login', async (_event, username, password) => {
    const res = loginUser(username, password)
    if (res.success) {
      initDB(res.dbFilename)
      setMasterPassword(password, res.salt)
    }
    return res
  })

  ipcMain.handle('app:list', () => listApps())
  ipcMain.handle('app:search', (_, query) => searchApps(query))
  ipcMain.handle('app:create', (_, data) => createApp(data))
  ipcMain.handle('app:update', (_, data) => updateCredential(data))
  ipcMain.handle('app:delete', (_, id) => deleteApp(id))
  ipcMain.handle('app:history', (_, id) => getHistory(id))
  ipcMain.handle('app:copy', (_, text) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('app:clearMasterKey', () => {
    clearMasterKey()
    closeVault()
  })

  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow?.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.on('window:close', () => {
    mainWindow?.close()
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
