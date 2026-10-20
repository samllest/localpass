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
  exportVault: () => ipcRenderer.invoke('vault:export'),
  importVault: () => ipcRenderer.invoke('vault:import'),
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
