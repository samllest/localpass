import { app, shell, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage } from 'electron'
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
  setMasterPassword,
  isVaultUnlocked
} from './db'
import { initBridgeServer, closeBridgeServer } from './bridge'
import { initializeStorage } from './storage'
import { acquireSingleInstance } from './single-instance'
import { createCloseController, readClosePreference, clearClosePreference } from './close-behavior'
import { chooseProjectAccount, cancelProjectChoices } from './project-choice'

// 兼容从受限环境（注入了宿主 Electron 环境变量的会话）启动：
// GPU 子进程派生会崩溃（0xC0000005），改为主进程内软件渲染，普通桌面环境无感知差异
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()

let mainWindow
let clipboardClearTimer = null
let currentUsername = null
const hasInstanceLock = acquireSingleInstance(app, () => mainWindow)
let tray = null
const closePreferenceFile = join(app.getPath('userData'), 'close-preference.json')
const closeController = createCloseController({
  app,
  dialog,
  isUnlocked: isVaultUnlocked,
  preferenceFile: closePreferenceFile,
  enterBackground: () => {
    if (tray && !tray.isDestroyed()) return
    const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
    if (icon.isEmpty()) throw new Error('Tray icon unavailable')
    const candidate = new Tray(icon.resize({ width: 16, height: 16 }))
    try {
      candidate.setToolTip('LocalPass · 本地密码管理器')
      candidate.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开 LocalPass', click: showMainWindow },
          { type: 'separator' },
          { label: '退出 LocalPass', click: () => closeController.quit() }
        ])
      )
      candidate.on('click', showMainWindow)
      candidate.on('double-click', showMainWindow)
      tray = candidate
    } catch (error) {
      candidate.destroy()
      throw error
    }
  }
})

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

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

  closeController.attach(mainWindow)
  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (/^https?:\/\//i.test(details.url)) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  const window = mainWindow
  initBridgeServer(window.webContents, { chooseAccount: chooseProjectAccount }).catch((error) => {
    console.error('[Bridge] Unable to start browser connection:', error.code || error.message)
    if (window.isDestroyed()) return
    const detail =
      error.code === 'EADDRINUSE'
        ? '本机连接端口 35320 已被占用。请关闭其他 LocalPass 窗口（包括开发版），然后重新打开此程序。密码库仍可正常使用。'
        : '暂时无法连接浏览器扩展，请重新启动 LocalPass。密码库仍可正常使用。'
    dialog
      .showMessageBox(window, {
        type: 'warning',
        title: '浏览器连接暂不可用',
        message: '浏览器扩展暂时无法连接此窗口',
        detail,
        buttons: ['知道了']
      })
      .catch((dialogError) => console.error('[Bridge] Unable to show notice:', dialogError.message))
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app
  .whenReady()
  .then(async () => {
    if (!hasInstanceLock) return
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
    ipcMain.handle('window:closePreference', () => readClosePreference(closePreferenceFile))
    ipcMain.handle('window:resetClosePreference', () => clearClosePreference(closePreferenceFile))
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
      cancelProjectChoices()
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
      else showMainWindow()
    })
  })
  .catch((error) => {
    dialog.showErrorBox('无法打开本地密码库', error.message || '初始化失败，现有数据库文件已保留')
    app.quit()
  })

app.on('before-quit', () => {
  cancelProjectChoices()
  closeController.allowQuit()
  tray?.destroy()
  tray = null
  void closeBridgeServer()
  closeVault()
  currentUsername = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
