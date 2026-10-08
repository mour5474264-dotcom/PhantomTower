import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import sharp from 'sharp'
import {ref, watch, nextTick} from 'vue'
import {createThumbnailCache} from '../server/image-thumbnails.js'
import {imageThumbnailUrl, resultImageSource} from '../src/utils/image-preview.mjs'

test('4K originals become bounded thumbnails, concurrent requests share work and disk cache survives restart', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-thumbnails-'))
  t.after(() => fs.rm(directory, {recursive: true, force: true}))
  const original = await sharp({create: {width: 4096, height: 2304, channels: 4, background: '#389cba'}}).png().toBuffer()
  let loads = 0
  const options = {directory, sharp: () => sharp, loadImage: async () => { loads++; return {buffer: original} }}
  const thumbnail = createThumbnailCache(options)
  const [first, duplicate] = await Promise.all([thumbnail('image-a'), thumbnail('image-a')])
  assert.equal(loads, 1)
  assert.deepEqual(first, duplicate)
  const metadata = await sharp(first).metadata()
  assert.equal(metadata.width, 640)
  assert.equal(metadata.height, 360)
  assert.equal(metadata.format, 'webp')
  assert(first.length < original.length)
  const reopened = createThumbnailCache({...options, loadImage: () => { throw new Error('must use cache') }})
  assert.deepEqual(await reopened('image-a'), first)
  assert.equal((await sharp(original).metadata()).width, 4096)
})

test('thumbnail work has bounded concurrency and a failed image can be retried', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-thumbnails-'))
  t.after(() => fs.rm(directory, {recursive: true, force: true}))
  const buffer = await sharp({create: {width: 32, height: 16, channels: 3, background: 'red'}}).png().toBuffer()
  let active = 0, peak = 0, fail = true
  const thumbnail = createThumbnailCache({directory, sharp: () => sharp, loadImage: async source => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 10))
    active--
    if (source === 'broken' && fail) throw new Error('unavailable')
    return {buffer}
  }})
  const responses = await Promise.allSettled(['a', 'broken', 'b', 'c', 'd'].map(thumbnail))
  assert.equal(responses.filter(result => result.status === 'rejected').length, 1)
  assert.equal(peak, 2)
  fail = false
  const metadata = await sharp(await thumbnail('broken')).metadata()
  assert.equal(metadata.width, 32, 'small images should not be enlarged')
})

test('cards request thumbnails while full-size actions keep the original source', () => {
  const source = 'http://127.0.0.1:4317/api/generated/sample.png'
  const item = {url: 'data:image/png;base64,large', exportUrl: source}
  assert.equal(resultImageSource(item), source)
  const url = new URL(imageThumbnailUrl(resultImageSource(item)))
  assert.equal(url.searchParams.get('url'), source)
  assert.equal(url.searchParams.get('thumbnail'), '1')
  assert.equal(imageThumbnailUrl('blob:upload'), 'blob:upload')
  assert.equal(imageThumbnailUrl(''), '')
})

test('image load and thumbnail fallback do not save the entire workspace; real result edits do', async () => {
  const source = (await fs.readFile(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  const memory = source.slice(source.indexOf('function resultMemoryItem('), source.indexOf('function editParentMemoryItem('))
  const watcher = source.slice(source.indexOf('watch([\n  model,'), source.indexOf('onBeforeUnmount(() => {', source.indexOf('watch([\n  model,')))
  const names = ['model', 'presetId', 'prompt', 'count', 'resolution', 'aspectRatio', 'format', 'size', 'customWidth', 'customHeight', 'mode', 'imageOperation', 'threeViewSource', 'clothingScope', 'personReplaceVariant', 'replaceObject', 'editParent', 'materials']
  const results = ref([{id: 'a', url: 'http://127.0.0.1:4317/api/generated/a.png', label: '样片', imageLoading: true, task: {status: 'done'}}])
  let saves = 0
  const stop = vm.runInNewContext(`${memory}\n${watcher}`, {
    ...Object.fromEntries(names.map(name => [name, ref('')])), results, watch,
    scheduleHomeMemoryPersist: () => saves++
  })
  try {
    results.value[0].imageLoading = false
    results.value[0].thumbnailFailed = true
    results.value[0].task.status = 'unused'
    await nextTick()
    assert.equal(saves, 0)
    results.value[0].label = 'updated'
    await nextTick()
    assert.equal(saves, 1)
    results.value.push({id: 'b', loading: true})
    await nextTick()
    assert.equal(saves, 2)
  } finally { stop() }
})
