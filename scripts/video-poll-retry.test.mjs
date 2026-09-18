import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {isRetryableVideoQuery, videoQueryRetryDelay} from '../src/services/video-poll-retry.js'

const source = readFileSync(new URL('../src/views/video/useVideoWorkbench.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '')

function workbench(query, onWait = () => {}) {
  const delays = []
  const context = {
    localforage: {createInstance: () => ({setItem: async () => {}})},
    ref: value => ({value}), computed: fn => ({get value() { return fn() }}),
    watch() {}, onActivated() {}, onDeactivated() {}, onMounted() {}, onBeforeUnmount() {},
    ElMessage: {error() {}}, AbortController, isRetryableVideoQuery, videoQueryRetryDelay,
    pollVideoGenerationTask: query,
    setTimeout(fn, ms) { delays.push(ms); queueMicrotask(() => { onWait(); fn() }); return 1 },
    clearTimeout() {},
  }
  return {app: vm.runInNewContext(`${source}; useVideoWorkbench()`, context), delays}
}
const record = () => ({id: 'record', status: 'paused', task: {id: 'paid-task', model: 'original-group:model'}, config: {}})
const httpError = status => new Error('fetch failed', {cause: {response: {status}}})

test('query errors are classified without retrying authentication or cancellation', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableVideoQuery(httpError(status)), true)
  for (const status of [400, 401, 403, 404]) assert.equal(isRetryableVideoQuery(httpError(status)), false)
  assert.equal(isRetryableVideoQuery({code: 'ERR_CANCELED'}), false)
  assert.equal(isRetryableVideoQuery(new Error('fetch failed')), true)
})

test('temporary 500 then pending then completion queries the same paid task', async () => {
  const saved = record()
  let calls = 0
  const {app, delays} = workbench(async (config, task) => {
    assert.equal(task, saved.task)
    assert.equal(config, saved.config)
    calls++
    if (calls === 1) throw httpError(500)
    return calls === 2 ? {status: 'pending'} : {status: 'completed', result: {url: 'https://example.test/video.mp4'}}
  })
  await app.poll(saved)
  assert.equal(saved.status, 'completed')
  assert.equal(saved.error, '')
  assert.deepEqual(delays, [4000, 4000])
  assert.equal(calls, 3)
})

test('persistent failure uses bounded backoff and preserves task for resuming', async () => {
  const saved = record()
  const {app, delays} = workbench(async () => { throw httpError(502) })
  await app.poll(saved)
  assert.equal(saved.status, 'paused')
  assert.match(saved.error, /连续 10 次/)
  assert.equal(saved.task.id, 'paid-task')
  assert.deepEqual(delays, [4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
})

test('manual pause during retry prevents another query', async () => {
  const saved = record()
  let calls = 0
  const {app} = workbench(async () => { calls++; throw httpError(500) }, () => { void app.pause(saved) })
  await app.poll(saved)
  assert.equal(saved.status, 'paused')
  assert.equal(calls, 1)
})

test('auth errors pause immediately and upstream terminal failures stay failed', async () => {
  for (const query of [async () => { throw httpError(401) }, async () => ({status: 'failed', error: 'provider rejected'})]) {
    const saved = record()
    const {app, delays} = workbench(query)
    await app.poll(saved)
    assert.equal(saved.status, saved.error === 'provider rejected' ? 'failed' : 'paused')
    assert.deepEqual(delays, [])
  }
})
