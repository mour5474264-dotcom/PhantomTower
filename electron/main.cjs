const { app, BrowserWindow, dialog, utilityProcess, ipcMain, net, safeStorage, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const licenseConfig = require('./license-config.cjs')
let serverProcess
let serverExitCode = null
let mainWindow = null
let macUpdateUrl = null
let serverToken = ''

function sendUpdate(type, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`update:${type}`, data)
}

function compareVersions(a, b) {
  const left = String(a).replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b).replace(/^v/i, '').split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) - (right[index] || 0)
  }
  return 0
}

async function checkMacUpdate() {
  const response = await net.fetch('https://api.github.com/repos/mour5474264-dotcom/PhantomTower/releases/latest', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'PhantomTower-updater' }
  })
  if (!response.ok) throw new Error(`GitHub 更新检查失败（${response.status}）`)
  const release = await response.json()
  const version = String(release.tag_name || '').replace(/^v/i, '')
  if (!version || compareVersions(version, app.getVersion()) <= 0) {
    sendUpdate('not-available', app.getVersion())
    return { updateInfo: null, version: app.getVersion() }
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find((item) => item.name.endsWith('.dmg') && item.name.includes(`-${arch}.`))
    || assets.find((item) => item.name.endsWith('.dmg'))
  if (!asset) throw new Error('此 Release 没有可用的 macOS DMG')
  macUpdateUrl = asset.browser_download_url
  const info = { version, url: macUpdateUrl, manual: true, arch }
  sendUpdate('available', info)
  return { updateInfo: info }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return
  if (process.platform === 'darwin') {
    setTimeout(() => checkMacUpdate().catch((error) => sendUpdate('error', error.message)), 3000)
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => sendUpdate('available', { version: info.version, manual: false }))
  autoUpdater.on('update-not-available', (info) => sendUpdate('not-available', info.version || app.getVersion()))
  autoUpdater.on('download-progress', (progress) => sendUpdate('progress', Math.round(progress.percent)))
  autoUpdater.on('update-downloaded', (info) => sendUpdate('downloaded', info.version))
  autoUpdater.on('error', (error) => sendUpdate('error', String(error?.message || error)))
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000)
}

function secretKeyPath() { return path.join(app.getPath('userData'), 'secrets.key') }
function loadServerSecretKey() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法安全保存 API Key')
  const target = secretKeyPath()
  try {
    const encrypted = fs.readFileSync(target, 'utf8')
    const key = safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    if (/^[a-f0-9]{64}$/i.test(key)) return key
  } catch {}
  const key = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, safeStorage.encryptString(key).toString('base64'), 'utf8')
  fs.renameSync(temporary, target)
  return key
}

function createWindow() {
  const preload = path.join(__dirname, 'preload.cjs')
  if (!fs.existsSync(preload)) throw new Error(`授权 preload 文件不存在：${preload}`)
  const icon = path.join(__dirname, 'icon', 'phantom-tower.ico')
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#f1eee7',
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload
    }
  })
  const indexFile = path.join(__dirname, '..', 'web-dist', 'index.html')
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const message = `页面加载失败（${errorCode}）：${errorDescription}\n${validatedURL}`
    console.error(message)
    dialog.showErrorBox('样片工厂页面加载失败', `${message}\n\n请查看 data/server.log 或重新安装应用。`)
  })
  mainWindow = win
  win.loadFile(indexFile).catch((error) => {
    const message = `无法加载页面文件：${indexFile}\n${error.message}`
    console.error(message)
    dialog.showErrorBox('样片工厂启动失败', message)
  })
}

function licenseFilePath() { return path.join(app.getPath('userData'), 'license.json') }
function readLicenseState() {
  try { return JSON.parse(fs.readFileSync(licenseFilePath(), 'utf8')) } catch { return {} }
}
function writeLicenseState(state) {
  const target = licenseFilePath()
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(temporary, target)
}
function ensureDeviceId(state) {
  if (!state.deviceId) {
    state.deviceId = crypto.randomUUID()
    writeLicenseState(state)
  }
  return state.deviceId
}
function configuredApiBaseUrl() {
  const url = String(licenseConfig.apiBaseUrl || '').replace(/\/$/, '')
  if (!url || url.includes('REPLACE_WITH_YOUR_WORKER')) throw new Error('尚未配置授权服务器地址')
  return url
}
function friendlyLicenseError(error) {
  const message = String(error?.message || error || '')
  if (message.includes('invalid_or_expired_license')) return '许可证无效或已过期，请检查 PT 许可证是否完整。'
  if (message.includes('device_limit_reached')) return '该许可证已达到设备数量上限，请联系管理员处理。'
  if (message.includes('尚未配置')) return message
  if (message.includes('ERR_CONNECTION_REFUSED')) return '无法连接授权服务器，可能是网络代理未启动或连接被拒绝。'
  if (message.includes('ConnectTimeout') || message.includes('ETIMEDOUT') || message.includes('fetch failed')) return '连接授权服务器超时，请检查网络或代理后重试。'
  if (message.includes('Failed to fetch')) return '无法连接授权服务器，请检查网络后重试。'
  return '授权服务暂时不可用，请稍后重试。'
}
function formatStatus(state, message) {
  const now = Date.now()
  const expiresAt = state.expiresAt ? Date.parse(state.expiresAt) : 0
  const graceMs = Number(licenseConfig.offlineGraceHours || 0) * 60 * 60 * 1000
  if (!state.token || !expiresAt) return { state: 'needs_activation', message: message || '请输入许可证以激活本机' }
  if (expiresAt > now) return { state: 'authorized', expiresAt: state.expiresAt, message: message || '授权有效' }
  if (graceMs > 0 && expiresAt + graceMs > now) return { state: 'authorized', expiresAt: state.expiresAt, message: '离线宽限期内，请尽快联网验证' }
  return { state: 'expired', expiresAt: state.expiresAt, message: message || '授权已过期，请联网重新验证' }
}
async function activateLicense(licenseKey) {
  const normalizedKey = String(licenseKey || '').trim()
  if (!normalizedKey) throw new Error('请输入许可证')
  const state = readLicenseState()
  const deviceId = ensureDeviceId(state)
  // Electron's network stack honors the system proxy settings used by the browser.
  const response = await net.fetch(`${configuredApiBaseUrl()}/v1/license/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ licenseKey: normalizedKey, deviceId })
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.error || '激活失败')
    error.licenseRejected = true
    throw error
  }
  writeLicenseState({ deviceId, licenseKey: normalizedKey, token: result.token, expiresAt: result.expiresAt })
  return formatStatus(readLicenseState())
}

async function getLicenseStatus() {
  const state = readLicenseState()
  if (!state.licenseKey) return formatStatus(state)
  try {
    return await activateLicense(state.licenseKey)
  } catch (error) {
    if (error.licenseRejected) return { state: 'expired', message: friendlyLicenseError(error) }
    return { state: 'expired', message: '无法连接授权服务器，请联网验证后继续使用' }
  }
}

ipcMain.handle('license:get-status', () => getLicenseStatus())
ipcMain.handle('server:get-token', () => serverToken)
ipcMain.handle('license:activate', async (_event, licenseKey) => {
  try { return await activateLicense(licenseKey) }
  catch (error) { throw new Error(friendlyLicenseError(error)) }
})
ipcMain.handle('license:clear', () => {
  const state = readLicenseState()
  writeLicenseState({ deviceId: state.deviceId })
  return { state: 'needs_activation', message: '请输入许可证以激活本机' }
})
ipcMain.handle('dialog:choose-directory', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  return result.canceled ? '' : (result.filePaths[0] || '')
})
ipcMain.handle('update:check', () => {
  if (!app.isPackaged) return { updateInfo: null, version: app.getVersion(), dev: true }
  return process.platform === 'darwin' ? checkMacUpdate() : autoUpdater.checkForUpdates().catch((error) => {
    sendUpdate('error', error.message)
    return null
  })
})
ipcMain.handle('update:install', async () => {
  if (process.platform === 'darwin') {
    if (!macUpdateUrl) throw new Error('请先检查更新')
    await shell.openExternal(macUpdateUrl)
    return { manual: true }
  }
  return autoUpdater.quitAndInstall()
})

function syncBundledPresets(dataDir) {
  const bundledFile = path.join(process.resourcesPath, 'data', 'presets.json')
  const userFile = path.join(dataDir, 'presets.json')
  if (!fs.existsSync(bundledFile)) return
  fs.mkdirSync(dataDir, { recursive: true })
  const bundled = JSON.parse(fs.readFileSync(bundledFile, 'utf8'))
  let existing = []
  try { existing = JSON.parse(fs.readFileSync(userFile, 'utf8')) } catch {}
  const bundledIds = new Set(bundled.map((item) => item.id))
  const merged = [...bundled, ...existing.filter((item) => !bundledIds.has(item.id))]
  const temporary = `${userFile}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(merged, null, 2), 'utf8')
  fs.renameSync(temporary, userFile)
}

function syncBundledPromptTemplates(dataDir) {
  const names = ['prompt-templates.json', 'prompt-templates.defaults.json', 'builtin-prompt-templates.json', 'builtin-prompt-templates.defaults.json']
  fs.mkdirSync(dataDir, { recursive: true })
  for (const name of names) {
    const bundledFile = path.join(process.resourcesPath, 'data', name)
    const userFile = path.join(dataDir, name)
    if (fs.existsSync(bundledFile) && !fs.existsSync(userFile)) fs.copyFileSync(bundledFile, userFile)
  }
  // Versions before the split stored function rules in the user preset file.
  const userFile = path.join(dataDir, 'prompt-templates.json')
  const builtInFile = path.join(dataDir, 'builtin-prompt-templates.json')
  try {
    const builtInIds = new Set(JSON.parse(fs.readFileSync(builtInFile, 'utf8')).map((item) => item.id))
    const userTemplates = JSON.parse(fs.readFileSync(userFile, 'utf8'))
    const migrated = userTemplates.filter((item) => !builtInIds.has(item.id))
    if (migrated.length !== userTemplates.length) fs.writeFileSync(userFile, JSON.stringify(migrated, null, 2), 'utf8')
  } catch {}
}

function migrateLegacyData(legacyDir, dataDir) {
  if (path.resolve(legacyDir) === path.resolve(dataDir) || !fs.existsSync(legacyDir)) return
  fs.mkdirSync(dataDir, { recursive: true })
  // Older Windows builds stored settings and generated files beside the install.
  // Copy only missing files so an existing user-data directory always wins.
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const source = path.join(legacyDir, entry.name)
    const target = path.join(dataDir, entry.name)
    if (fs.existsSync(target)) continue
    try { fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false }) } catch (error) { console.warn(`无法迁移旧数据 ${source}: ${error.message}`) }
  }
}

function migrateLegacySecretKey(legacyDir) {
  const target = secretKeyPath()
  if (fs.existsSync(target)) return
  const candidates = [path.join(legacyDir, 'secrets.key'), path.join(legacyDir, '..', 'secrets.key')]
  for (const source of candidates) {
    try {
      if (!fs.existsSync(source)) continue
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(source, target)
      return
    } catch (error) { console.warn(`无法迁移旧加密密钥 ${source}: ${error.message}`) }
  }
}

async function waitForServer(expectedDataDir) {
  let lastError
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverExitCode !== null) throw new Error(`本地数据服务已退出，退出码：${serverExitCode}`)
    try {
      const response = await fetch('http://127.0.0.1:4317/api/health')
      const health = await response.json()
      if (!response.ok || !health.ok) throw new Error('本地数据服务状态异常')
      if (path.resolve(health.dataDir) !== path.resolve(expectedDataDir)) throw new Error('端口 4317 已被另一个 PhantomTower 服务占用，请先关闭旧版本或开发服务')
      return
    } catch (error) {
      lastError = error
      if (error.message.includes('端口 4317')) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError || new Error('本地数据服务启动超时')
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
else app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
})

app.whenReady().then(async () => {
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'index.js')
    : path.join(__dirname, '..', 'server', 'index.js')
  const serverCwd = app.isPackaged ? path.dirname(serverEntry) : path.join(__dirname, '..')
  const installDir = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..')
  // Keep runtime data outside the install bundle/directory so updates never
  // remove API settings, presets, history, or generated files.
  const dataDir = path.join(app.getPath('userData'), 'data')
  migrateLegacySecretKey(path.join(installDir, 'data'))
  migrateLegacyData(path.join(installDir, 'data'), dataDir)
  // Keep the default export location in the application's data directory.
  let exportDir = path.join(dataDir, 'export')
  if (app.isPackaged) {
    syncBundledPresets(dataDir)
    syncBundledPromptTemplates(dataDir)
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(exportDir, { recursive: true })
  const serverEnv = { ...process.env, PHANTOMTOWER_DATA_DIR: dataDir, PHANTOMTOWER_EXPORT_DIR: exportDir }
  serverToken = crypto.randomBytes(32).toString('hex')
  serverEnv.PHANTOMTOWER_SERVER_TOKEN = serverToken
  serverEnv.PHANTOMTOWER_VISION_MODELS_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'vision-models')
    : path.join(__dirname, '..', 'vision-models')
  serverEnv.PHANTOMTOWER_SECRET_KEY = loadServerSecretKey()
  const logPath = path.join(dataDir, 'server.log')
  const log = fs.createWriteStream(logPath, { flags: 'a' })
  serverExitCode = null
  serverProcess = utilityProcess.fork(serverEntry, [], {
    cwd: serverCwd,
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'PhantomTower Local Server'
  })
  serverProcess.stdout.pipe(log, { end: false })
  serverProcess.stderr.pipe(log, { end: false })
  serverProcess.on('exit', (code) => { serverExitCode = code })
  try {
    await waitForServer(dataDir)
    createWindow()
    setupAutoUpdate()
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
  } catch (error) {
    dialog.showErrorBox('PhantomTower 启动失败', `${error.message}\n\n日志：${logPath}`)
    app.quit()
  }
})
app.on('window-all-closed', () => { if (serverProcess) serverProcess.kill(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { if (serverProcess) serverProcess.kill() })
