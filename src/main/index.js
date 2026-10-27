import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  clipboard,
  Tray,
  Menu,
  nativeImage,
  safeStorage,
  powerMonitor,
  Notification
} from 'electron'
import { join } from 'path'
import { readFile, stat, writeFile } from 'fs/promises'
import { dialog } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

import { initSystemDb, registerUser, loginUser, closeSystemDb, getUpdateAccount } from './auth'
import {
  initDB,
  copyVaultKey,
  restoreVaultKey,
  getVaultInfo,
  getVaultRevision,
  listApps,
  searchApps,
  createApp,
  updateApp,
  updateCredential,
  deleteApp,
  closeVault,
  getHistory,
  exportVaultData,
  importVaultData,
  setMasterPassword,
  isVaultUnlocked,
  listTrash,
  restoreApp,
  purgeTrash,
  importBrowserRecords,
  changeVaultMasterPassword,
  getTotpCode
} from './db'
import { initBridgeServer, closeBridgeServer } from './bridge'
import { initializeStorage, isolateBrowserSession } from './storage'
import { createStorageSnapshot } from './storage-backup'
import { acquireSingleInstance } from './single-instance'
import { createCloseController, readClosePreference, clearClosePreference } from './close-behavior'
import { chooseProjectAccount, cancelProjectChoices } from './project-choice'
import { autoUpdater } from 'electron-updater'
import { createUpdateManager } from './updates'
import { createExtensionUpdateManager } from './extension-updates'
import { createUpdateSession } from './update-session'
import { createUnlockSession, IDLE_LOCK_MINUTES } from './unlock-session'
import { loadBridgeSecret } from './bridge-auth'
import { createAutomaticBackup } from './automatic-backup'
import { parseBrowserPasswords } from '../shared/password-import'
import { checkPasswordBreaches } from './breach-check'
import { createLaunchAtLogin } from './launch-at-login'

// 兼容从受限环境（注入了宿主 Electron 环境变量的会话）启动：
// GPU 子进程派生会崩溃（0xC0000005），改为主进程内软件渲染，普通桌面环境无感知差异
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('disable-gpu')
app.disableHardwareAcceleration()
isolateBrowserSession()

let mainWindow
let clipboardClearTimer = null
let currentUsername = null
let updateSession
let unlockSession
let installingUpdate = false
const hasInstanceLock = acquireSingleInstance(app, () => mainWindow)
let tray = null
let updates
let updateCheckTimer
let updateStartupTimer
let extensionUpdates
let extensionUpdateTimer
let bridgeSecret
let automaticBackup
let backupTimer
let idleLockTimer
let idleLockMinutes = IDLE_LOCK_MINUTES
const securitySettingsFile = join(app.getPath('userData'), 'security-settings.json')

function lockVault() {
  unlockSession?.clear()
  updateSession?.clear()
  cancelProjectChoices()
  closeVault()
  currentUsername = null
  if (clipboardClearTimer) {
    clearTimeout(clipboardClearTimer)
    clipboardClearTimer = null
    clipboard.clear()
  }
  mainWindow?.webContents.send('auth:locked')
}
function checkUnlockSession() {
  if (isVaultUnlocked() && unlockSession?.expired()) lockVault()
}
function recordVaultActivity() {
  checkUnlockSession()
  return isVaultUnlocked() && Boolean(unlockSession?.touch())
}
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
          { label: '锁定密码库', click: lockVault },
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
  initBridgeServer(window.webContents, {
    chooseAccount: chooseProjectAccount,
    secret: bridgeSecret,
    beforeAccess: checkUnlockSession,
    onActivity: recordVaultActivity,
    extensionStatus: (version) => extensionUpdates?.reportBrowserVersion(version)
  }).catch((error) => {
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
    bridgeSecret = await loadBridgeSecret(
      app.isPackaged ? app.getPath('userData') : join(app.getAppPath(), '.localpass-data')
    )
    automaticBackup = createAutomaticBackup({
      directory: join(
        app.isPackaged ? app.getPath('userData') : join(app.getAppPath(), '.localpass-data'),
        'recovery',
        'automatic'
      ),
      snapshot: createStorageSnapshot,
      notify: (message) => {
        mainWindow?.webContents.send('backup:failed', message)
        if (Notification.isSupported())
          new Notification({ title: 'LocalPass 自动备份失败', body: message }).show()
      }
    })
    await automaticBackup.initialize()
    void automaticBackup.run()
    backupTimer = setInterval(() => void automaticBackup.run(), 15 * 60 * 1000)
    setInterval(
      () => {
        if (isVaultUnlocked()) purgeTrash()
      },
      60 * 60 * 1000
    ).unref()
    ipcMain.handle('backup:state', () => automaticBackup.status())
    ipcMain.handle('backup:openFolder', () => shell.openPath(automaticBackup.status().directory))
    try {
      const settings = JSON.parse(await readFile(securitySettingsFile, 'utf8'))
      if (
        settings.unlockSessionPolicy === 1 &&
        [0, 5, 15, 30, 60, IDLE_LOCK_MINUTES].includes(settings.idleLockMinutes)
      )
        idleLockMinutes = settings.idleLockMinutes
    } catch {
      /* Defaults keep background capture available. */
    }
    powerMonitor.on('resume', checkUnlockSession)
    powerMonitor.on('unlock-screen', checkUnlockSession)
    idleLockTimer = setInterval(checkUnlockSession, 30000)
    ipcMain.handle('security:state', () => ({ idleLockMinutes }))
    ipcMain.handle('security:setIdle', async (_, minutes) => {
      if (![0, 5, 15, 30, 60, IDLE_LOCK_MINUTES].includes(minutes))
        throw new Error('闲置锁定时间无效')
      await writeFile(
        securitySettingsFile,
        JSON.stringify({ idleLockMinutes: minutes, unlockSessionPolicy: 1 }),
        {
          mode: 0o600
        }
      )
      idleLockMinutes = minutes
      return { idleLockMinutes }
    })
    updateSession = createUpdateSession({ folder: app.getPath('userData'), safeStorage })
    unlockSession = createUnlockSession({
      folder: app.getPath('userData'),
      safeStorage,
      idleMinutes: () => idleLockMinutes
    })
    const validateAccount = (account) =>
      account && getUpdateAccount(account.username)?.fingerprint === account.fingerprint
    const restoreAccount = (account, key) => {
      try {
        initDB(account.dbFilename)
        restoreVaultKey(key)
      } catch (error) {
        closeVault()
        throw error
      }
    }
    const hadSavedSession = unlockSession.hasSavedSession()
    let restored = unlockSession.restore(validateAccount, restoreAccount)
    // Accept the old installer-only handoff once when upgrading from an older
    // release, but never let it bypass an expired or revoked remembered session.
    if (!restored && !hadSavedSession) {
      restored = updateSession.restore(validateAccount, restoreAccount)
      if (restored) unlockSession.remember(restored, copyVaultKey())
    }
    if (!restored) updateSession.clear()
    currentUsername = restored?.username || null
    ipcMain.handle('auth:session', () => {
      checkUnlockSession()
      return { unlocked: isVaultUnlocked() }
    })
    ipcMain.on('auth:activity', (event) => {
      if (event.sender === mainWindow?.webContents) recordVaultActivity()
    })
    const launchAtLogin = createLaunchAtLogin({ app })
    ipcMain.handle('startup:state', () => launchAtLogin.getState())
    ipcMain.handle('startup:setEnabled', (_event, enabled) => launchAtLogin.setEnabled(enabled))

    function rememberUpdateSession() {
      if (isVaultUnlocked() && currentUsername) {
        updateSession.remember(getUpdateAccount(currentUsername), copyVaultKey())
      }
    }
    function rememberUnlockedSession() {
      rememberUpdateSession()
      if (isVaultUnlocked() && currentUsername)
        unlockSession.remember(getUpdateAccount(currentUsername), copyVaultKey())
    }
    if (restored) rememberUpdateSession()

    updates = createUpdateManager({
      updater: autoUpdater,
      version: app.getVersion(),
      supported: app.isPackaged && process.platform === 'win32',
      settingsFile: join(app.getPath('userData'), 'update-settings.json'),
      notify: (state) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('updates:changed', state)
      },
      install: async () => {
        showMainWindow()
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: '安装 LocalPass 更新',
          message: '现在重启并安装更新？',
          detail: '安装期间浏览器保存与填充会暂停，现有本地密码库会保留。',
          buttons: ['取消', '重启并安装'],
          defaultId: 1,
          cancelId: 0,
          noLink: true
        })
        if (result.response !== 1) return
        await createStorageSnapshot()
        // before-quit allows the installer to exit without the normal close-to-tray prompt.
        installingUpdate = updateSession.prepare()
        try {
          autoUpdater.quitAndInstall(false, true)
        } catch (error) {
          installingUpdate = false
          rememberUpdateSession()
          throw error
        }
      }
    })
    ipcMain.handle('updates:state', () => updates.snapshot())
    ipcMain.handle('updates:check', () => updates.check())
    ipcMain.handle('updates:download', () => updates.download())
    ipcMain.handle('updates:install', () => updates.install())
    ipcMain.handle('updates:setServer', (_event, url) => updates.setServer(url))
    extensionUpdates = createExtensionUpdateManager({
      bridgeSecret,
      sourceFolder: app.isPackaged
        ? join(process.resourcesPath, 'chrome-extension')
        : join(app.getAppPath(), 'chrome-extension'),
      dataFolder: app.isPackaged
        ? app.getPath('userData')
        : join(app.getAppPath(), '.localpass-data'),
      serverUrl: () => updates.snapshot().serverUrl
    })
    await extensionUpdates.initialize().catch((error) => {
      console.error('[Extension] Unable to prepare auto-update directory:', error.message)
    })
    ipcMain.handle('extension:state', () => extensionUpdates.snapshot())
    ipcMain.handle('extension:check', () => extensionUpdates.check())
    ipcMain.handle('extension:bind', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择浏览器当前加载的 LocalPass 扩展目录',
        properties: ['openDirectory']
      })
      if (result.canceled) return { ...extensionUpdates.snapshot(), cancelled: true }
      return extensionUpdates.bind(result.filePaths[0])
    })
    if (app.isPackaged && process.platform === 'win32') {
      updateStartupTimer = setTimeout(() => {
        void updates.check()
        void extensionUpdates.check()
      }, 8000)
      updateCheckTimer = setInterval(() => void updates.check(), 4 * 60 * 60 * 1000)
      extensionUpdateTimer = setInterval(() => void extensionUpdates.check(), 15 * 60 * 1000)
    }

    electronApp.setAppUserModelId('com.electron')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.handle('auth:register', async (_event, username, password) => {
      const res = registerUser(username, password, (account) => {
        try {
          initDB(account.dbFilename, { createIfMissing: true })
          setMasterPassword(password, account.salt)
        } catch (error) {
          closeVault()
          throw error
        }
      })
      if (res.success) {
        currentUsername = res.username
        rememberUnlockedSession()
      }
      return res
    })

    ipcMain.handle('auth:login', async (_event, username, password) => {
      const res = loginUser(username, password)
      if (res.success) {
        try {
          initDB(res.dbFilename)
          setMasterPassword(password, res.salt)
          purgeTrash()
          currentUsername = res.username
          rememberUnlockedSession()
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
    ipcMain.handle('app:trash', () => listTrash())
    ipcMain.handle('app:restore', (_, id) => restoreApp(id))
    ipcMain.handle('app:totp', (_, id) => getTotpCode(id))
    ipcMain.handle('app:breachCheck', async () => {
      const revision = getVaultRevision()
      const records = listApps()
      const fingerprints = JSON.stringify(records.map((record) => [record.id, record.password]))
      const leaked = await checkPasswordBreaches(records)
      if (!isVaultUnlocked() || getVaultRevision() !== revision) throw new Error('密码库会话已变化')
      if (fingerprints !== JSON.stringify(listApps().map((record) => [record.id, record.password])))
        throw new Error('密码已变化，请重新检查')
      return { leaked, checkedAt: new Date().toISOString() }
    })
    ipcMain.handle('app:openWebsite', (_, value) => {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网站地址无效')
      return shell.openExternal(url.href)
    })
    ipcMain.handle(
      'app:contextMenu',
      (event, options) =>
        new Promise((resolve) => {
          const items = options?.group
            ? [
                ['view', '查看账号'],
                ['add', '添加账号'],
                ...(options.website
                  ? [
                      ['open', '打开网站'],
                      ['url', '复制网址']
                    ]
                  : [])
              ]
            : [
                ['username', '复制用户名'],
                ['password', '复制密码'],
                ['edit', '编辑账号'],
                ['history', '历史版本'],
                ['favorite', '收藏 / 取消收藏'],
                ['delete', '移入回收站']
              ]
          const menu = Menu.buildFromTemplate(
            items.map(([id, label]) => ({ label, click: () => resolve(id) }))
          )
          menu.popup({
            window: BrowserWindow.fromWebContents(event.sender),
            callback: () => resolve(null)
          })
        })
    )
    ipcMain.handle('vault:changeMasterPassword', async (_, oldPassword, nextPassword) => {
      if (!currentUsername || !isVaultUnlocked()) throw new Error('请先解锁密码库')
      const account = loginUser(currentUsername, oldPassword)
      if (!account.success) throw new Error(account.error)
      const revision = getVaultRevision()
      await automaticBackup.run({ force: true })
      if (automaticBackup.status().error) throw new Error('修改主密码前备份失败，已停止修改')
      if (revision !== getVaultRevision()) throw new Error('密码库会话已变化，请重新解锁')
      closeSystemDb()
      try {
        changeVaultMasterPassword(account, nextPassword)
      } finally {
        initSystemDb()
      }
      updateSession.clear()
      rememberUnlockedSession()
      return { success: true }
    })
    ipcMain.handle('vault:importBrowser', async () => {
      if (!isVaultUnlocked()) throw new Error('请先解锁密码库')
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入 Chrome / Edge 密码',
        properties: ['openFile'],
        filters: [{ name: '浏览器密码 CSV', extensions: ['csv'] }]
      })
      if (result.canceled) return { canceled: true }
      if ((await stat(result.filePaths[0])).size > 50 * 1024 * 1024) throw new Error('文件过大')
      const parsed = parseBrowserPasswords(await readFile(result.filePaths[0], 'utf8'))
      const revision = getVaultRevision()
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        message: `导入 ${parsed.records.length} 个账号？`,
        detail: '相同账号密码自动跳过；密码不同则保留为独立记录。',
        buttons: ['取消', '导入'],
        cancelId: 0,
        defaultId: 1
      })
      if (confirm.response !== 1) return { canceled: true }
      if (!isVaultUnlocked() || revision !== getVaultRevision()) throw new Error('密码库会话已变化')
      const imported = importBrowserRecords(parsed.records)
      mainWindow?.webContents.send('app:refreshList')
      return { ...imported, skipped: parsed.skipped }
    })
    ipcMain.handle('vault:info', () => ({ ...getVaultInfo(), username: currentUsername }))
    ipcMain.handle('vault:openFolder', () => {
      shell.showItemInFolder(getVaultInfo().dbPath)
    })
    ipcMain.handle('extension:openFolder', async () => {
      const folder = extensionUpdates.snapshot().folder
      const error = await shell.openPath(folder)
      if (error) throw new Error('无法打开扩展目录：' + error)
    })
    ipcMain.handle('window:closePreference', () => readClosePreference(closePreferenceFile))
    ipcMain.handle('window:resetClosePreference', () => clearClosePreference(closePreferenceFile))
    ipcMain.handle('vault:export', async (_, passphrase) => {
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出加密密码备份',
        defaultPath: 'localpass-backup.json',
        filters: [
          { name: 'LocalPass 加密 JSON', extensions: ['json'] },
          { name: 'LocalPass 备份', extensions: ['localpass'] }
        ]
      })
      if (result.canceled || !result.filePath) return { canceled: true }
      await writeFile(result.filePath, exportVaultData(passphrase), {
        encoding: 'utf8',
        mode: 0o600
      })
      return { canceled: false, filePath: result.filePath }
    })
    ipcMain.handle('vault:selectImport', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入加密密码库',
        properties: ['openFile'],
        filters: [{ name: 'LocalPass 加密备份', extensions: ['localpass', 'json'] }]
      })
      if (result.canceled || !result.filePaths[0]) return { canceled: true }
      const fileInfo = await stat(result.filePaths[0])
      if (fileInfo.size > 50 * 1024 * 1024) throw new Error('备份文件过大，无法导入')
      const serialized = await readFile(result.filePaths[0], 'utf8')
      return { canceled: false, serialized }
    })
    ipcMain.handle('vault:import', (_, serialized, passphrase) => {
      const imported = importVaultData(serialized, passphrase)
      mainWindow?.webContents.send('app:refreshList')
      return { canceled: false, imported }
    })
    ipcMain.handle('app:copy', (_, text) => {
      if (!isVaultUnlocked()) throw new Error('请先解锁密码库')
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
      lockVault()
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
  if (!installingUpdate && !updateSession?.pending()) updateSession?.clear()
  clearTimeout(updateStartupTimer)
  clearInterval(updateCheckTimer)
  clearInterval(extensionUpdateTimer)
  clearInterval(backupTimer)
  clearInterval(idleLockTimer)
  cancelProjectChoices()
  closeController.allowQuit()
  tray?.destroy()
  tray = null
  void closeBridgeServer()
  closeVault()
  closeSystemDb()
  currentUsername = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
