const { contextBridge, ipcRenderer } = require('electron')
const licenseConfig = require('./license-config.cjs')
contextBridge.exposeInMainWorld('phantomTowerServer', {
  getToken: () => ipcRenderer.invoke('server:get-token')
})

contextBridge.exposeInMainWorld('phantomTowerLicense', {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', licenseKey),
  clear: () => ipcRenderer.invoke('license:clear'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  checkIntervalMinutes: licenseConfig.licenseCheckIntervalMinutes
})

contextBridge.exposeInMainWorld('phantomTowerUpdate', {
  check: () => ipcRenderer.invoke('update:check'),
  install: () => ipcRenderer.invoke('update:install'),
  on: (callback) => {
    const handlers = ['available', 'progress', 'downloaded', 'not-available', 'error'].map((type) => {
      const handler = (_event, data) => callback({ type, data })
      ipcRenderer.on(`update:${type}`, handler)
      return [type, handler]
    })
    return () => handlers.forEach(([type, handler]) => ipcRenderer.removeListener(`update:${type}`, handler))
  }
})
