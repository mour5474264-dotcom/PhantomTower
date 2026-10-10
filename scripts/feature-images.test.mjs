import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import {ref, computed, watch, markRaw} from 'vue'

const source = readFileSync(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')

function extract(name, next, context) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(`\n${next}`, start)
  assert(start >= 0 && end > start)
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : ''
  return vm.runInNewContext(`${prefix}${source.slice(start, end)}; ${name}`, context)
}

function setup() {
  const revoked = []
  const input = {value: 'photo.png'}
  const context = {
    ref, computed, watch, markRaw,
    videoImportController: {abort() {}},
    editParent: ref(null),
    globalThis: {URL: {revokeObjectURL: url => revoked.push(url)}},
    URL: {createObjectURL: file => `blob:${file.name}`},
    normalizeImageFile: file => file, rawFile: file => file,
    personReplaceVariant: ref('double'), MAX_REFERENCE_IMAGE_SIDE: 4096,
    error: ref(''), materialLabels: {reference: 'Reference'}, showMessage() {},
    imageDimensions: async () => ({width: 100, height: 100})
  }
  const start = source.indexOf('function createMaterialBuckets(')
  const end = source.indexOf("const threeViewSource =", start)
  Object.assign(context, vm.runInNewContext(`${source.slice(start, end)};
    ({createMaterialBuckets, materialsByFeature, materialUploadRoot, mode, imageOperation, currentFeature, materials})`, context))
  context.materialUploadRoot.value = {querySelectorAll: () => [input]}
  for (const [name, next] of [
    ['revokeMaterialPreview', 'function clearMaterialBucket('],
    ['clearMaterialBucket', 'function clearCurrentImages('],
    ['clearCurrentImages', 'function clearAllFeatureImages('],
    ['clearAllFeatureImages', 'function resultMemoryItem('],
    ['addFiles', 'function removeFile('],
    ['removeFile', 'async function refresh(']
  ]) context[name] = extract(name, next, context)
  context.mode.value = 'image'
  return {context, revoked, input}
}

test('switching features restores their images and deletion stays in the active feature', () => {
  const {context: c} = setup()
  c.materials.value.reference.push({name: 'batch', previewUrl: 'blob:batch'})
  c.imageOperation.value = 'three-view'
  assert.equal(c.materials.value.reference.length, 0)
  c.materials.value.reference.push({name: 'three-view'})
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference[0].name, 'batch')
  c.removeFile('reference', 0)
  c.imageOperation.value = 'three-view'
  assert.equal(c.materials.value.reference[0].name, 'three-view')
})

test('clearing releases current previews and resets input without clearing other features', () => {
  const {context: c, revoked, input} = setup()
  c.materials.value.reference.push({previewUrl: 'blob:batch'})
  c.imageOperation.value = 'three-view'
  c.materials.value.reference.push({previewUrl: 'blob:three-view'})
  c.materials.value.videoReference.push({previewUrl: 'blob:video-frame'})
  c.clearCurrentImages()
  assert.equal(c.materials.value.reference.length, 0)
  assert.equal(c.materials.value.videoReference.length, 0)
  assert.equal(input.value, '')
  assert.deepEqual(revoked, ['blob:three-view', 'blob:video-frame'])
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference.length, 1)
})

test('upload finishing after a feature switch writes to its original feature', async () => {
  const {context: c} = setup()
  let finish
  c.imageDimensions = () => new Promise(resolve => {finish = resolve})
  const upload = c.addFiles('reference', {name: 'photo.png', size: 10})
  c.imageOperation.value = 'three-view'
  finish({width: 100, height: 100})
  await upload
  assert.equal(c.materials.value.reference.length, 0)
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference[0].name, 'photo.png')
})

test('clearing invalidates pending uploads and permits selecting the same file again', async () => {
  const {context: c} = setup()
  let finish
  c.imageDimensions = () => new Promise(resolve => {finish = resolve})
  const file = {name: 'photo.png', size: 10}
  const upload = c.addFiles('reference', file)
  c.clearCurrentImages()
  finish({width: 100, height: 100})
  await upload
  assert.equal(c.materials.value.reference.length, 0)
  c.imageDimensions = async () => ({width: 100, height: 100})
  await c.addFiles('reference', file)
  assert.equal(c.materials.value.reference.length, 1)
})

test('new task clears every feature and revokes inactive previews', () => {
  const {context: c, revoked} = setup()
  c.materials.value.reference.push({previewUrl: 'blob:batch'})
  c.imageOperation.value = 'edit'
  c.materials.value.reference.push({previewUrl: 'blob:edit'})
  c.clearAllFeatureImages()
  assert.equal(c.materials.value.reference.length, 0)
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference.length, 0)
  assert.deepEqual(revoked, ['blob:edit', 'blob:batch'])
})

test('clearing another feature preserves the edit image parent', () => {
  const {context: c} = setup()
  c.editParent.value = {id: 'original'}
  c.clearCurrentImages()
  assert.equal(c.editParent.value.id, 'original')
  c.imageOperation.value = 'edit'
  c.clearCurrentImages()
  assert.equal(c.editParent.value, null)
})

test('saved feature images round trip and legacy images restore to the saved image operation', async () => {
  const {context: c} = setup()
  for (const key of ['model', 'presetId', 'prompt', 'count', 'resolution', 'aspectRatio', 'format', 'size',
    'customWidth', 'customHeight', 'threeViewSource', 'clothingScope', 'replaceObject', 'selected']) c[key] = ref('')
  c.results = ref([])
  Object.assign(c, {
    HOME_MEMORY_VERSION: 1, visibleImageOperations: ['batch', 'three-view', 'edit'],
    geminiAspectRatioOptions: [{value: '1:1'}], clothingScopes: {outfit: 'Outfit'},
    materialMemoryItem: item => ({name: item.name}), restoreMaterialItem: item => item,
    editParentMemoryItem: item => item, resultMemoryItem: item => item, restoreResultItem: item => item,
    restorePersistedResultImages: async () => {}, restoreStaleResultPreviews() {},
    console: {warn: (...args) => {throw new Error(args.join(' '))}}
  })
  const snapshot = extract('makeHomeMemorySnapshot', 'async function restoreHomeMemory(', c)
  let saved
  c.readHomeMemory = async () => saved
  const restore = extract('restoreHomeMemory', 'function scheduleHomeMemoryPersist(', c)
  c.materials.value.reference.push({name: 'batch'})
  c.imageOperation.value = 'three-view'
  c.materials.value.reference.push({name: 'three-view'})
  saved = snapshot()
  c.clearAllFeatureImages()
  await restore()
  assert.equal(c.materials.value.reference[0].name, 'three-view')
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference[0].name, 'batch')
  c.clearAllFeatureImages()
  saved = {version: 1, form: {mode: 'text', imageOperation: 'three-view'}, materials: {reference: [{name: 'legacy'}]}}
  await restore()
  assert.equal(c.materials.value.reference.length, 0)
  c.mode.value = 'image'
  assert.equal(c.materials.value.reference[0].name, 'legacy')
  c.imageOperation.value = 'batch'
  assert.equal(c.materials.value.reference.length, 0)
})
