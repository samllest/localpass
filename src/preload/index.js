import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Custom APIs for renderer
const api = {
  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Authentication
  register: (username, password) => ipcRenderer.invoke('auth:register', username, password),
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),

  // App Management
  listApps: () => ipcRenderer.invoke('app:list'),
  searchApps: (query) => ipcRenderer.invoke('app:search', query),
  createApp: (data) => ipcRenderer.invoke('app:create', data),
  updateCredential: (data) => ipcRenderer.invoke('app:update', data),
  deleteApp: (id) => ipcRenderer.invoke('app:delete', id),
  getHistory: (id) => ipcRenderer.invoke('app:history', id),
  copyToClipboard: (text) => ipcRenderer.invoke('app:copy', text),
  clearMasterKey: () => ipcRenderer.invoke('app:clearMasterKey'),
  onRefreshList: (callback) => ipcRenderer.on('app:refreshList', (_event, ...args) => callback(...args))
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
