import { app, shell, BrowserWindow, ipcMain, clipboard } from 'electron'
import { join } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { dialog } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { initSystemDb, registerUser, loginUser } from './auth'
import {
  initDB,
  getVaultInfo,
  listApps,
  searchApps,
  createApp,
  updateApp,
  updateCredential,
  deleteApp,
  clearMasterKey,
  closeVault,
  getHistory,
  exportVaultData,
  importVaultData,
  setMasterPassword
} from './db'
import { initBridgeServer } from './bridge'
import { initializeStorage } from './storage'

// 兼容从受限环境（注入了宿主 Electron 环境变量的会话）启动：
// GPU 子进程派生会崩溃（0xC0000005），改为主进程内软件渲染，普通桌面环境无感知差异
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

let mainWindow
let clipboardClearTimer = null
let currentUsername = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  initBridgeServer(mainWindow.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(async () => {
    await initializeStorage()
    initSystemDb()

    electronApp.setAppUserModelId('com.electron')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('auth:register', async (_event, username, password) => {
      const res = registerUser(username, password)
      if (res.success) {
        try {
          initDB(res.dbFilename, { createIfMissing: true })
          setMasterPassword(password, res.salt)
          currentUsername = res.username
        } catch (error) {
          closeVault()
          currentUsername = null
          return { success: false, error: error.message || '无法创建密码库，请检查存储目录' }
        }
      }
      return res
    })

    ipcMain.handle('auth:login', async (_event, username, password) => {
      const res = loginUser(username, password)
      if (res.success) {
        try {
          initDB(res.dbFilename)
          setMasterPassword(password, res.salt)
          currentUsername = res.username
        } catch (error) {
          closeVault()
          currentUsername = null
          return { success: false, error: error.message || '无法打开密码库，请检查原文件' }
        }
      }
      return res
    })

    ipcMain.handle('app:list', () => listApps())
    ipcMain.handle('app:search', (_, query) => searchApps(query))
    ipcMain.handle('app:create', (_, data) => createApp(data))
    ipcMain.handle('app:update', (_, data) => updateApp(data))
    ipcMain.handle('app:updateCredential', (_, data) => updateCredential(data))
    ipcMain.handle('app:delete', (_, id) => deleteApp(id))
    ipcMain.handle('app:history', (_, id) => getHistory(id))
    ipcMain.handle('vault:info', () => ({ ...getVaultInfo(), username: currentUsername }))
    ipcMain.handle('vault:openFolder', () => {
      shell.showItemInFolder(getVaultInfo().dbPath)
    })
    ipcMain.handle('extension:openFolder', async () => {
      const folder = app.isPackaged
        ? join(process.resourcesPath, 'chrome-extension')
        : join(app.getAppPath(), 'chrome-extension')
      const error = await shell.openPath(folder)
      if (error) throw new Error('无法打开扩展目录：' + error)
    })
    ipcMain.handle('vault:export', async () => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出加密密码库',
        defaultPath: 'localpass-backup.localpass',
        filters: [{ name: 'LocalPass 加密备份', extensions: ['localpass'] }]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await writeFile(result.filePath, exportVaultData(), 'utf8')
      return { canceled: false, filePath: result.filePath }
    })
    ipcMain.handle('vault:import', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入加密密码库',
        properties: ['openFile'],
        filters: [{ name: 'LocalPass 加密备份', extensions: ['localpass', 'json'] }]
      })
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      const imported = importVaultData(await readFile(result.filePaths[0], 'utf8'))
      mainWindow?.webContents.send('app:refreshList')
      return { canceled: false, imported }
    })
    ipcMain.handle('app:copy', (_, text) => {
      const copiedText = text == null ? '' : String(text)
      clipboard.writeText(copiedText)

      if (clipboardClearTimer) {
        clearTimeout(clipboardClearTimer)
        clipboardClearTimer = null
      }

      clipboardClearTimer = setTimeout(() => {
        if (clipboard.readText() === copiedText) {
          clipboard.clear()
        }
        clipboardClearTimer = null
      }, 30_000)

      return true
    })
    ipcMain.handle('app:clearMasterKey', () => {
      clearMasterKey()
      closeVault()
      currentUsername = null
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
  .catch((error) => {
    dialog.showErrorBox('无法打开本地密码库', error.message || '初始化失败，现有数据库文件已保留')
    app.quit()
  })

app.on('before-quit', () => {
  closeVault()
  currentUsername = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
