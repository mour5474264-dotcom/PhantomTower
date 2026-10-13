import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import {createGenerationResponseGuard} from '../server/generation-response-guard.js'
import {matchBackgrounds} from '../src/utils/background-match.mjs'

const workspace = readFileSync(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
function workspaceFunction(name, nextName, context = {}, source = workspace) {
    const start = source.indexOf(`function ${name}(`)
    const asyncStart = source.slice(start - 6, start) === 'async ' ? start - 6 : start
    const end = source.indexOf(`\nfunction ${nextName}(`, start)
    const asyncEnd = source.indexOf(`\nasync function ${nextName}(`, start)
    const boundary = [end, asyncEnd].filter((index) => index >= 0).sort((a, b) => a - b)[0]
    assert(start >= 0 && boundary > start, `Cannot locate ${name}`)
    return vm.runInNewContext(`${source.slice(asyncStart, boundary)}; ${name}`, context)
}

test('concurrent tasks cannot claim the same Gemini response', async () => {
    const claim = createGenerationResponseGuard()
    const response = {apiId: 'relay-a', model: 'gemini', responseId: 'response-1'}
    const results = await Promise.all(['task-a', 'task-b'].map(async (taskId) => claim({...response, taskId})))
    assert.equal(results[0], null)
    assert.equal(results[1].taskId, 'task-a')
    assert.equal(claim({...response, responseId: 'response-2'}), null)
    assert.equal(claim({...response, apiId: 'relay-b'}), null)
    assert.equal(claim({...response, model: 'other-model'}), null)
    assert.equal(claim({...response, responseId: undefined}), null)
})

test('response guard remembers successful responses after restart and stays bounded', () => {
    const entry = {apiId: 'relay', model: 'gemini', responseId: 'old', requestId: 'original'}
    const claim = createGenerationResponseGuard([
        {...entry, status: 'success-response', upstream: {responseId: 'old'}}
    ], 2)
    assert.equal(claim(entry).requestId, 'original')
    assert.equal(claim({...entry, responseId: 'new-1'}), null)
    assert.equal(claim({...entry, responseId: 'new-2'}), null)
    assert.equal(claim(entry), null)
})

test('a duplicate response is rejected before it can be written as a successful generation', () => {
    const duplicateCheck = server.indexOf('const duplicateResponse = claimGenerationResponse(')
    const successLog = server.indexOf("await appendGenerationLog({...responseLog, status: 'success-response'})")
    assert(duplicateCheck >= 0)
    assert(successLog > duplicateCheck)
})

test('UI preserves safety, size and duplicate-response errors distinctly', () => {
    const summarize = workspaceFunction('generationErrorSummary', 'imageUrlFromOutput')
    assert.match(summarize({status: 400, message: '图片或提示词未通过内容安全审核'}), /内容安全审核/)
    assert.equal(summarize({status: 400, message: '不支持 4096x4096 尺寸'}), '不支持 4096x4096 尺寸')
    assert.match(summarize({status: 400}), /查看具体原因/)
    assert.match(summarize({status: 502, details: {code: 'UPSTREAM_DUPLICATE_RESPONSE'}}), /重复的生成响应/)
})

test('two batch targets send distinct first images with the same person reference', async () => {
    const first = {file: {assetId: 'target-a'}}
    const second = {file: {assetId: 'target-b'}}
    const person = {file: {assetId: 'person'}}
    const materialSet = {reference: [first, second], person: [person], batchReference: [], pose: [], scene: [], prop: []}
    const buildTasks = workspaceFunction('buildImageTasks', 'imageValidationError', {
        materials: {value: materialSet}, imageOperation: {value: 'batch'}
    })
    const buildReferences = workspaceFunction('buildLabeledReferences', 'imageDimensions', {
        rawFile: (item) => item.file,
        fileToAssetReference: async (file) => file,
        referenceRole: (key) => key === 'reference' ? 'target_reference' : `${key}_reference`,
        referencePromptLabel: (key) => key,
        materialLabels: {}
    })
    const references = await Promise.all(buildTasks().map((task) => buildReferences(task, materialSet)))
    assert.equal(references.length, 2)
    assert.equal(references[0][0].data.assetId, 'target-a')
    assert.equal(references[1][0].data.assetId, 'target-b')
    for (const images of references) {
        assert.equal(images.length, 2)
        assert.equal(images[0].primary, true)
        assert.equal(images[1].data.assetId, 'person')
    }
})

test('background replacement pairs each target with one scene image and never uses a person mask', async () => {
    const targetA = {file: {assetId: 'target-a'}, width: 1600, height: 900}
    const targetB = {file: {assetId: 'target-b'}, width: 900, height: 1600}
    const sceneA = {file: {assetId: 'scene-a'}, width: 1600, height: 900}
    const sceneB = {file: {assetId: 'scene-b'}, width: 900, height: 1600}
    const materialSet = {reference: [targetA, targetB], scene: [sceneA, sceneB]}
    const buildTasks = workspaceFunction('buildImageTasks', 'imageValidationError', {
        materials: {value: materialSet}, imageOperation: {value: 'background'},
        matchBackgrounds
    })
    const buildReferences = workspaceFunction('buildLabeledReferences', 'imageDimensions', {
        rawFile: (item) => item.file,
        fileToAssetReference: async (file) => file,
        referenceRole: (key) => key === 'reference' ? 'target_reference' : `${key}_reference`,
        referencePromptLabel: (key) => key,
        materialLabels: {}
    })
    const tasks = buildTasks()
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].type, 'background')
    assert.equal(tasks[0].operation, 'background')
    const references = await Promise.all(tasks.map((task) => buildReferences(task, materialSet)))
    assert.deepEqual(references.map((items) => Array.from(items, (item) => item.data.assetId)), [
        ['target-a', 'scene-a'],
        ['target-b', 'scene-b']
    ])
    assert.deepEqual(references.map((items) => Array.from(items, (item) => item.role)), [
        ['target_reference', 'scene_reference'],
        ['target_reference', 'scene_reference']
    ])

    const requests = []
    let maskCalls = 0
    const results = {value: tasks.map((_task, index) => ({id: `result-${index}`, loading: true, taskId: `task-${index}`}))}
    const runGeneration = workspaceFunction('runGeneration', 'generate', {
        AbortController, activeGenerationWorks: new Set(), running: {value: false},
        availableTemplates: {value: []}, buildLabeledReferences: buildReferences,
        generatePersonMask: async () => {maskCalls += 1; return {mask: 'person-only-mask'}},
        getRequestSize: async () => '', resolveGeminiAspectRatio: async () => '',
        results, cancelledTaskIds: new Set(), generationControllers: new Map(),
        queuedCount: {value: 0}, completedCount: {value: 0}, error: {value: ''},
        buildMaterialPrompt: workspaceFunction('buildMaterialPrompt', 'buildTasks', {
            materialPromptRule: () => ''
        }),
        generateImage: async (request) => {
            requests.push(request)
            return {data: [{url: 'mock://generated'}]}
        },
        logGenerationResponse() {}, imageUrlFromOutput: (output) => output?.url,
        imageLoadsImmediately: () => true, showMessage() {},
        generationErrorSummary: (error) => error.message,
        editParent: {value: null}, crypto: {randomUUID: () => 'fallback-task'},
        persistHomeMemoryAfterGeneration: false, scheduleHomeMemoryPersist() {}
    })
    await runGeneration({
        tasks,
        jobs: Array.from(tasks, (task, index) => ({task, taskId: `task-${index}`})),
        resultStart: 0,
        materialSnapshot: materialSet,
        requestConfig: {
            model: 'test-image-model', modelConfigId: 'test-config', protocol: 'openai-images',
            prompt: '', presetId: '', builtinVariant: null, mode: 'image',
            replaceObject: '', quality: 'high', format: 'png', resolution: '1K', aspectRatio: 'auto'
        }
    })
    assert.equal(requests.length, 2)
    assert.equal(maskCalls, 0)
    assert.deepEqual(requests.map((request) => Array.from(request.images, (image) => image.assetId)), [
        ['target-a', 'scene-a'],
        ['target-b', 'scene-b']
    ])
    for (const request of requests) {
        assert.equal(request.operation, 'background')
        assert.equal(request.mask, '')
        assert.match(request.prompt, /背景参考图/)
        assert.match(request.prompt, /只替换主目标图中人物背后的环境/)
    }
})

test('server drops masks for background edits and scene-aware batch edits', () => {
    const imageEditMask = workspaceFunction('imageEditMask', 'activeApi', {}, server)
    assert.equal(imageEditMask('background', [{role: 'scene_reference'}], 'mask-data'), '')
    assert.equal(imageEditMask('batch', [{role: 'scene_reference'}], 'mask-data'), '')
    assert.equal(imageEditMask('batch', [{role: 'person_reference'}], 'mask-data'), 'mask-data')
})

test('background requests select the dedicated built-in prompt', () => {
    const operation = workspaceFunction('promptTemplateOperation', 'imageEditMask', {}, server)
    const matches = workspaceFunction('promptTemplateMatches', 'savePromptTemplates', {}, server)
    const templates = JSON.parse(readFileSync(new URL('../data/builtin-prompt-templates.json', import.meta.url), 'utf8'))
    const selected = templates.find((item) => matches(item, 'image', operation('background', 'image')))
    assert.equal(selected?.id, 'background-replace')
})
