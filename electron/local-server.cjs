const crypto = require('node:crypto')
const path = require('node:path')

const healthUrl = 'http://127.0.0.1:4317/api/health'

function createLocalServerManager({ fork, fetchHealth = fetch, entry, cwd, env, dataDir, log, logPath, onStatus, timeoutMs = 30_000, stopTimeoutMs = 5_000 }) {
  let child = null
  let childExited = false
  let exitCode = null
  let pending = null
  let disposed = false
  let status = { state: 'starting', message: '正在启动本地数据服务...', logPath }

  function setStatus(state, message) {
    status = { state, message, logPath }
    onStatus?.(status)
    return status
  }

  async function stopChild() {
    const previous = child
    if (!previous) return
    if (!childExited) {
      await new Promise((resolve, reject) => {
        const onExit = () => { clearTimeout(timer); resolve() }
        const timer = setTimeout(() => {
          previous.removeListener('exit', onExit)
          reject(new Error('旧的本地数据服务未能停止，请关闭程序后重试'))
        }, stopTimeoutMs)
        previous.once('exit', onExit)
        try { previous.kill() }
        catch (error) {
          clearTimeout(timer)
          previous.removeListener('exit', onExit)
          reject(error)
        }
      })
    }
    if (child === previous) child = null
  }

  function spawnChild() {
    const instanceId = crypto.randomUUID()
    const process = fork(entry, [], {
      cwd,
      env: { ...env, PHANTOMTOWER_SERVER_INSTANCE: instanceId },
      stdio: ['ignore', 'pipe', 'pipe'],
      serviceName: 'PhantomTower Local Server'
    })
    child = process
    childExited = false
    exitCode = null
    process.stdout.pipe(log, { end: false })
    process.stderr.pipe(log, { end: false })
    process.on('exit', (code) => {
      if (child !== process) return
      childExited = true
      exitCode = code
      if (!pending && !disposed) setStatus('error', `本地数据服务已退出，退出码：${code ?? '未知'}`)
    })
    return instanceId
  }

  async function waitForReady(instanceId) {
    let lastError
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (childExited) throw new Error(`本地数据服务已退出，退出码：${exitCode ?? '未知'}`)
      try {
        const remaining = Math.max(1, deadline - Date.now())
        const response = await fetchHealth(healthUrl, { signal: AbortSignal.timeout(Math.min(1_500, remaining)) })
        const health = await response.json()
        if (!response.ok || !health.ok) throw new Error('本地数据服务状态异常')
        if (path.resolve(health.dataDir || '') !== path.resolve(dataDir) || health.instanceId !== instanceId) {
          throw new Error('端口 4317 已被另一个本地数据服务占用，请先关闭旧版本或开发服务')
        }
        if (childExited) throw new Error(`本地数据服务已退出，退出码：${exitCode ?? '未知'}`)
        return
      } catch (error) {
        lastError = error
        if (error.message.includes('端口 4317')) throw error
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
      }
    }
    if (childExited) throw new Error(`本地数据服务已退出，退出码：${exitCode ?? '未知'}`)
    const detail = lastError?.message ? `：${lastError.message}` : ''
    throw new Error(`本地数据服务启动超时（${Math.ceil(timeoutMs / 1000)} 秒内未能连接 127.0.0.1:4317）${detail}`)
  }

  function restart() {
    if (disposed) return Promise.reject(new Error('程序正在退出，无法重启本地数据服务'))
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      setStatus('starting', child ? '正在重启本地数据服务...' : '正在启动本地数据服务...')
      try {
        await stopChild()
        if (disposed) throw new Error('程序正在退出，无法重启本地数据服务')
        const instanceId = spawnChild()
        await waitForReady(instanceId)
        return setStatus('ready', '本地数据服务已就绪')
      } catch (error) {
        setStatus('error', error.message || String(error))
        throw error
      }
    }).finally(() => { pending = null })
    return pending
  }

  function dispose() {
    disposed = true
    if (child && !childExited) child.kill()
  }

  return { getStatus: () => status, restart, dispose }
}

module.exports = { createLocalServerManager }
