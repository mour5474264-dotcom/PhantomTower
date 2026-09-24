import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')
function extract(name, next, context = {}) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(`\n${next}`, start)
  assert(start >= 0 && end > start)
  const prefix = source.slice(start - 6, start) === 'async ' ? 'async ' : ''
  return vm.runInNewContext(`${prefix}${source.slice(start, end)}; ${name}`, context)
}

test('multiple references create one task and all reach the same request in upload order', async () => {
  const references = [1, 2, 3, 4].map(id => ({id}))
  const materials = {value: {reference: references, person: [{id: 'unrelated'}]}}
  const context = {materials, imageOperation: {value: 'three-view'}, threeViewMaterialKey: {value: 'reference'}, rawFile: item => item,
    fileToAssetReference: async file => ({assetId: file.id})}
  const build = extract('buildImageTasks', 'function imageValidationError(', context)
  const label = extract('buildLabeledReferences', 'async function imageDimensions(', context)
  const tasks = build()
  assert.equal(tasks.length, 1)
  const snapshot = {reference: [...references]}
  materials.value.reference = [{id: 'new upload'}]
  const labeled = await label(tasks[0], snapshot)
  assert.deepEqual(Array.from(labeled, item => item.data.assetId), [1, 2, 3, 4])
  assert(labeled.every(item => item.role === 'person_reference' && !item.primary))
  assert.equal(labeled[3].promptLabel, '人物参考图4')
  materials.value.reference = []
  assert.equal(build().length, 0)
})

test('video and image modes isolate references and queued tasks retain their source', async () => {
  const materials = {value: {reference: [{id: 'photo'}], videoReference: [{id: 'frame1'}, {id: 'frame2'}]}}
  const key = {value: 'videoReference'}
  const context = {materials, imageOperation: {value: 'three-view'}, threeViewMaterialKey: key,
    rawFile: item => item, fileToAssetReference: async file => file.id}
  const build = extract('buildImageTasks', 'function imageValidationError(', context)
  const label = extract('buildLabeledReferences', 'async function imageDimensions(', context)
  const [videoTask] = build()
  const snapshot = {reference: [...materials.value.reference], videoReference: [...materials.value.videoReference]}
  key.value = 'reference'
  assert.deepEqual(Array.from(await label(build()[0]), item => item.data), ['photo'])
  materials.value.videoReference = []
  assert.deepEqual(Array.from(await label(videoTask, snapshot), item => item.data), ['frame1', 'frame2'])
  key.value = 'videoReference'
  assert.equal(build().length, 0, 'photos cannot satisfy an empty video mode')
})

test('batch still isolates each target while including shared references', async () => {
  const materials = {value: {reference: [{id: 1}, {id: 2}], batchReference: [{id: 3}], person: [], pose: [], scene: [], prop: []}}
  const context = {materials, imageOperation: {value: 'batch'}, rawFile: item => item,
    fileToAssetReference: async file => file.id, referenceRole: key => key,
    referencePromptLabel: key => key, materialLabels: {}}
  const tasks = extract('buildImageTasks', 'function imageValidationError(', context)()
  assert.equal(tasks.length, 2)
  const label = extract('buildLabeledReferences', 'async function imageDimensions(', context)
  assert.deepEqual(Array.from(await label(tasks[0]), item => item.data), [1, 3])
  assert.deepEqual(Array.from(await label(tasks[1]), item => item.data), [2, 3])
})

test('fusion prompt requests body and head views without imposing a source canvas', () => {
  const prompt = extract('buildMaterialPrompt', 'function buildTasks(')(
    [{promptLabel: '人物参考图1'}, {promptLabel: '人物参考图2'}], 'three-view')
  assert.match(prompt, /图片2：人物参考图2/)
  assert.match(prompt, /全身正面、90度侧面、背面/)
  assert.match(prompt, /头部特写/)
  assert.match(prompt, /后脑发型/)
  assert.doesNotMatch(prompt, /本次主参考图|唯一身份参考/)
})

test('video references put the clearest identity anchor ahead of motion-affected frames', () => {
  const prompt = extract('buildMaterialPrompt', 'function buildTasks(')(
    [{promptLabel: '人物参考图1', videoReferenceRank: 1}, {promptLabel: '人物参考图2', videoReferenceRank: 2}], 'three-view'
  )
  assert.match(prompt, /视频人脸优选参考第1位/)
  assert.match(prompt, /排序靠前、检测到人脸且清晰可见的画面为身份锚点/)
  assert.match(prompt, /运动模糊、压缩噪点、遮挡、滤镜或光线改变而重塑人物身份/)
})

test('copy count applies to the group and auto ratio uses a landscape sheet', () => {
  const context = {isTextMode: {value: false}, imageValidationError: () => '', error: {value: ''},
    model: {value: 'test-model'}, taskCount: {value: 1}, buildTasks: () => [{type: 'three-view'}],
    selectedModel: {value: null}, selectedProtocol: {value: 'gemini'}, prompt: {value: ''},
    presetId: {value: ''}, imageOperation: {value: 'three-view'}, replaceObject: {value: ''},
    format: {value: 'png'}, resolution: {value: '2K'}, aspectRatio: {value: 'auto'},
    materials: {value: {reference: [1, 2, 3]}}, count: {value: 2}, crypto: {randomUUID: () => 'test'},
    running: {value: false}, completedCount: {value: 0}, generationTotal: {value: 0}, results: {value: []}}
  const create = extract('createGenerationWork', 'async function runGeneration(', context)
  const work = create()
  assert.equal(work.jobs.length, 2)
  assert.equal(work.requestConfig.aspectRatio, '3:2')
  context.aspectRatio.value = '16:9'
  assert.equal(create().requestConfig.aspectRatio, '16:9')
})
