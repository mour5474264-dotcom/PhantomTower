const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
let serverProcess
function createWindow() { const win = new BrowserWindow({ width: 1440, height: 920, minWidth: 1100, minHeight: 700, backgroundColor: '#f1eee7', webPreferences: { contextIsolation: true, nodeIntegration: false } }); win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')) }
app.whenReady().then(() => {
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'index.js')
    : path.join(__dirname, '..', 'server', 'index.js')
  const serverCwd = app.isPackaged ? path.dirname(serverEntry) : path.join(__dirname, '..')
  const serverEnv = app.isPackaged
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1', PHANTOMTOWER_DATA_DIR: path.join(app.getPath('userData'), 'data') }
    : process.env
  serverProcess = spawn(process.execPath, [serverEntry], { cwd: serverCwd, stdio: 'inherit', windowsHide: true, env: serverEnv })
  createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (serverProcess) serverProcess.kill(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { if (serverProcess) serverProcess.kill() })
