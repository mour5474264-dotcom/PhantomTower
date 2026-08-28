const { contextBridge, ipcRenderer } = require('electron')
const licenseConfig = require('./license-config.cjs')

contextBridge.exposeInMainWorld('phantomTowerLicense', {
  getStatus: () => ipcRenderer.invoke('license:get-status'),
  activate: (licenseKey) => ipcRenderer.invoke('license:activate', licenseKey),
  clear: () => ipcRenderer.invoke('license:clear'),
  chooseDirectory: () => ipcRenderer.invoke('dialog:choose-directory'),
  checkIntervalMinutes: licenseConfig.licenseCheckIntervalMinutes
})
