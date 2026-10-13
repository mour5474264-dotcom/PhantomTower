const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { PassThrough, Writable } = require('node:stream')
const { test } = require('node:test')
const { createLocalServerManager } = require('../electron/local-server.cjs')

class FakeProcess extends EventEmitter {
  constructor(instanceId) {
    super()
    this.instanceId = instanceId
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.killCount = 0
  }

  kill() {
    this.killCount += 1
    queueMicrotask(() => this.emit('exit', 0))
  }
}

function createHarness(fetchHealth, options = {}) {
  const processes = []
  const statuses = []
  const dataDir = path.resolve('local-server-test-data')
  const log = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  const manager = createLocalServerManager({
    fork: (_entry, _args, spawnOptions) => {
      const child = new FakeProcess(spawnOptions.env.PHANTOMTOWER_SERVER_INSTANCE)
      processes.push(child)
      return child
    },
    fetchHealth: (url, requestOptions) => fetchHealth({ url, requestOptions, processes, dataDir }),
    entry: 'server.js', cwd: process.cwd(), env: {}, dataDir, log,
    logPath: path.join(dataDir, 'server.log'),
    onStatus: (status) => statuses.push(status),
    timeoutMs: options.timeoutMs || 30,
    stopTimeoutMs: 100
  })
  return { manager, processes, statuses, dataDir }
}

test('failed startup can stop the old process and start a healthy new one', async () => {
  let canConnect = false
  const harness = createHarness(async ({ processes, dataDir }) => {
    if (!canConnect) throw new Error('fetch failed')
    return { ok: true, json: async () => ({ ok: true, dataDir, instanceId: processes.at(-1).instanceId }) }
  })

  await assert.rejects(harness.manager.restart(), /本地数据服务启动超时.*fetch failed/)
  assert.equal(harness.manager.getStatus().state, 'error')
  canConnect = true
  const [first, second] = await Promise.all([harness.manager.restart(), harness.manager.restart()])
  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  assert.equal(harness.processes.length, 2)
  assert.equal(harness.processes[0].killCount, 1)
  harness.manager.dispose()
})

test('an occupied port cannot be mistaken for the newly started service', async () => {
  const harness = createHarness(async ({ dataDir }) => ({
    ok: true,
    json: async () => ({ ok: true, dataDir, instanceId: 'another-service' })
  }))

  await assert.rejects(harness.manager.restart(), /端口 4317 已被另一个本地数据服务占用/)
  assert.equal(harness.manager.getStatus().state, 'error')
  harness.manager.dispose()
})

test('an unexpected service exit reopens the recovery state', async () => {
  const harness = createHarness(async ({ processes, dataDir }) => ({
    ok: true,
    json: async () => ({ ok: true, dataDir, instanceId: processes.at(-1).instanceId })
  }))

  await harness.manager.restart()
  harness.processes[0].emit('exit', 7)
  assert.match(harness.manager.getStatus().message, /退出码：7/)
  assert.equal(harness.manager.getStatus().state, 'error')
  await harness.manager.restart()
  assert.equal(harness.manager.getStatus().state, 'ready')
  assert.equal(harness.processes.length, 2)
  harness.manager.dispose()
})
