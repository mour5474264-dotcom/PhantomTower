import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import {createGenerationResponseGuard} from '../server/generation-response-guard.js'

const workspace = readFileSync(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
function workspaceFunction(name, nextName, context = {}) {
    const start = workspace.indexOf(`function ${name}(`)
    const asyncStart = workspace.slice(start - 6, start) === 'async ' ? start - 6 : start
    const end = workspace.indexOf(`\nfunction ${nextName}(`, start)
    const asyncEnd = workspace.indexOf(`\nasync function ${nextName}(`, start)
    const boundary = [end, asyncEnd].filter((index) => index >= 0).sort((a, b) => a - b)[0]
    assert(start >= 0 && boundary > start, `Cannot locate ${name}`)
    return vm.runInNewContext(`${workspace.slice(asyncStart, boundary)}; ${name}`, context)
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
