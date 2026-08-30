const {spawn} = require('node:child_process')
const path = require('node:path')

const rootDir = path.resolve(__dirname, '..')
const serverUrl = 'http://127.0.0.1:4317/api/health'
const expectedDataDir = path.resolve(rootDir, 'data')
const viteEntry = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')
const children = []
let shuttingDown = false

async function readHealth() {
    try {
        const response = await fetch(serverUrl)
        const health = await response.json().catch(() => ({}))
        if (!response.ok || !health.ok) return {ok: false, error: new Error('本地数据服务状态异常')}
        if (path.resolve(health.dataDir || '') !== expectedDataDir) {
            return {ok: false, error: new Error(`端口 4317 已被其他数据服务占用：${health.dataDir || '未知目录'}`)}
        }
        return {ok: true}
    } catch (error) {
        return {ok: false, error}
    }
}

async function waitForServer() {
    let lastError
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const result = await readHealth()
        if (result.ok) return false
        lastError = result.error
        if (lastError?.message.startsWith('端口 4317')) throw lastError
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`本地数据服务启动超时：${lastError?.message || '未知错误'}`)
}

function startServer() {
    const server = spawn(process.execPath, [path.join(rootDir, 'server', 'index.js')], {
        cwd: rootDir,
        env: {
            ...process.env,
            PHANTOMTOWER_DATA_DIR: expectedDataDir,
            PHANTOMTOWER_EXPORT_DIR: path.join(expectedDataDir, 'export'),
            PHANTOMTOWER_VISION_MODELS_DIR: path.join(rootDir, 'vision-models')
        },
        stdio: 'inherit'
    })
    children.push(server)
    server.once('error', (error) => {
        if (!shuttingDown) console.error(`本地数据服务启动失败：${error.message}`)
    })
    server.once('exit', (code, signal) => {
        if (!shuttingDown) {
            console.error(`本地数据服务已退出（${signal || `退出码 ${code ?? '未知'}`}）`)
            stopChildren(1)
        }
    })
    return server
}

function stopChildren(code = 0) {
    if (shuttingDown) return
    shuttingDown = true
    for (const child of children) {
        if (!child.killed) child.kill()
    }
    process.exitCode = code
}

async function main() {
    const existing = await readHealth()
    if (existing.ok) {
        console.log('PhantomTower local server is already running')
    } else {
        if (existing.error?.message.startsWith('端口 4317')) throw existing.error
        startServer()
        await waitForServer()
    }

    const vite = spawn(process.execPath, [viteEntry, ...process.argv.slice(2)], {
        cwd: rootDir,
        env: process.env,
        stdio: 'inherit'
    })
    children.push(vite)
    vite.once('exit', (code, signal) => {
        if (!shuttingDown) stopChildren(typeof code === 'number' ? code : (signal ? 1 : 0))
    })
}

process.once('SIGINT', () => stopChildren(130))
process.once('SIGTERM', () => stopChildren(143))
main().catch((error) => {
    console.error(error.message)
    stopChildren(1)
})
