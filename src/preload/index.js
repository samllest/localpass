import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  getClosePreference: () => ipcRenderer.invoke('window:closePreference'),
  resetClosePreference: () => ipcRenderer.invoke('window:resetClosePreference'),
  getStartupState: () => ipcRenderer.invoke('startup:state'),
  setStartupEnabled: (enabled) => ipcRenderer.invoke('startup:setEnabled', enabled),
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  setUpdateServer: (url) => ipcRenderer.invoke('updates:setServer', url),
  onUpdateState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('updates:changed', listener)
    return () => ipcRenderer.removeListener('updates:changed', listener)
  },

  getAuthSession: () => ipcRenderer.invoke('auth:session'),
  recordActivity: () => ipcRenderer.send('auth:activity'),
  onLocked: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('auth:locked', listener)
    return () => ipcRenderer.removeListener('auth:locked', listener)
  },
  getBackupState: () => ipcRenderer.invoke('backup:state'),
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),
  getSecurityState: () => ipcRenderer.invoke('security:state'),
  setIdleLock: (minutes) => ipcRenderer.invoke('security:setIdle', minutes),
  listTrash: () => ipcRenderer.invoke('app:trash'),
  restoreApp: (id) => ipcRenderer.invoke('app:restore', id),
  changeMasterPassword: (oldPassword, nextPassword) =>
    ipcRenderer.invoke('vault:changeMasterPassword', oldPassword, nextPassword),
  importBrowser: () => ipcRenderer.invoke('vault:importBrowser'),
  contextMenu: (options) => ipcRenderer.invoke('app:contextMenu', options),
  openWebsite: (url) => ipcRenderer.invoke('app:openWebsite', url),
  getTotpCode: (id) => ipcRenderer.invoke('app:totp', id),
  checkPasswordBreaches: () => ipcRenderer.invoke('app:breachCheck'),

  // Authentication
  register: (username, password) => ipcRenderer.invoke('auth:register', username, password),
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),

  // App Management
  listApps: () => ipcRenderer.invoke('app:list'),
  searchApps: (query) => ipcRenderer.invoke('app:search', query),
  createApp: (data) => ipcRenderer.invoke('app:create', data),
  updateApp: (data) => ipcRenderer.invoke('app:update', data),
  updateCredential: (data) => ipcRenderer.invoke('app:updateCredential', data),
  deleteApp: (id) => ipcRenderer.invoke('app:delete', id),
  getHistory: (id) => ipcRenderer.invoke('app:history', id),
  getVaultInfo: () => ipcRenderer.invoke('vault:info'),
  openVaultFolder: () => ipcRenderer.invoke('vault:openFolder'),
  openExtensionFolder: () => ipcRenderer.invoke('extension:openFolder'),
  getExtensionUpdateState: () => ipcRenderer.invoke('extension:state'),
  checkExtensionUpdate: () => ipcRenderer.invoke('extension:check'),
  bindExtensionFolder: () => ipcRenderer.invoke('extension:bind'),
  exportVault: (passphrase) => ipcRenderer.invoke('vault:export', passphrase),
  selectVaultImport: () => ipcRenderer.invoke('vault:selectImport'),
  importVault: (serialized, passphrase) =>
    ipcRenderer.invoke('vault:import', serialized, passphrase),
  copyToClipboard: (text) => ipcRenderer.invoke('app:copy', text),
  clearMasterKey: () => ipcRenderer.invoke('app:clearMasterKey'),
  onRefreshList: (callback) => {
    const listener = (_event, ...args) => callback(...args)
    ipcRenderer.on('app:refreshList', listener)
    return () => ipcRenderer.removeListener('app:refreshList', listener)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('localpass', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI
  window.localpass = api
}
