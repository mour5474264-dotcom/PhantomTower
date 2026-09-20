import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {ref, computed} from 'vue'

function workbench(process) {
  const source = readFileSync(new URL('../src/views/Texture.vue', import.meta.url), 'utf8')
    .match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  return new Function('ref', 'computed', 'onBeforeUnmount', 'onMounted', 'ElMessage', 'uploadImageAsset', 'processTextureImage', 'exportImages', 'URL',
    `${source}\nreturn {items,addFiles,processBatch,stopping,running,save,notice,removeSelected,clearAll,selectFailed}`)(
    ref, computed, () => {}, () => {}, {success() {}}, async file => ({assetId: file.name}), process,
    async urls => ({count: urls.length, exportDir: 'test'}), {createObjectURL: file => `blob:${file.name}`, revokeObjectURL() {}})
}
const file = name => ({name, size: 200})
test('multiple uploads append; individual failures retain other results; retry succeeds', async () => {
  let fail = true
  const page = workbench(async asset => {
    if (asset === 'b.png' && fail) throw new Error('test failure')
    return {url: `output:${asset}`}
  })
  await page.addFiles([file('a.png'), file('b.png')])
  await page.addFiles([file('c.jpg')])
  assert.deepEqual(page.items.value.map(item => item.group), [1,1,2])
  await page.processBatch()
  assert.deepEqual(page.items.value.map(item => item.status), ['done','failed','done'])
  assert.equal(page.items.value[0].original, 'blob:a.png')
  fail = false
  await page.processBatch([page.items.value[1]])
  assert.equal(page.items.value[1].output, 'output:b.png')
})
test('stop finishes current image and leaves remaining images pending', async () => {
  let page
  page = workbench(async asset => { page.stopping.value = true; return {url: `output:${asset}`} })
  await page.addFiles([file('a.png'),file('b.png')])
  await page.processBatch()
  assert.deepEqual(page.items.value.map(item => item.status), ['done','ready'])
  assert.equal(page.running.value, false)
})

test('failed selection and bulk deletion preserve other images; clear removes remaining rows', async () => {
  const page = workbench(async asset => {
    if (asset === 'b.png') throw new Error('failed')
    return {url: `output:${asset}`}
  })
  await page.addFiles([file('a.png'), file('b.png'), file('c.png')])
  page.selectFailed()
  assert.deepEqual(page.items.value.map(item => item.selected), [false, true, false])
  page.removeSelected()
  assert.deepEqual(page.items.value.map(item => item.asset), ['a.png', 'c.png'])
  page.running.value = true
  page.clearAll()
  assert.equal(page.items.value.length, 2)
  page.running.value = false
  page.clearAll()
  assert.equal(page.items.value.length, 0)
})
