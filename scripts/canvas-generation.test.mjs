import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {createCanvasGenerationHandler} from '../server/canvas-generation.js'
import {createVideoGenerationHandler} from '../server/video-generation.js'
import {seedanceVideoPayload} from '../server/seedance-video.js'

test('all canvas modes retain a selected local model and reject removed models', () => {
    const source = stripTypeScriptTypes(readFileSync(new URL('../src/canvas/stores/use-config-store.ts', import.meta.url), 'utf8'))
    const start = source.indexOf('export function modelMatchesCapability(')
    const end = source.indexOf('export function selectableModelsByCapability(', start)
    const resolve = vm.runInNewContext(`${source.slice(start, end).replaceAll('export function', 'function')}; resolveModelForCapability`, {defaultConfig: {}})
    const config = {channelMode: 'local', models: ['relay::model'], imageModel: 'relay::model', videoModel: 'relay::model', textModel: 'relay::model', audioModel: 'relay::model'}
    for (const mode of ['image', 'video', 'text', 'audio']) {
        assert.equal(resolve(config, 'relay::model', mode), 'relay::model')
        assert.equal(resolve({...config, models: []}, 'relay::model', mode), '')
    }
})

async function run({kind = 'audio', method = 'POST', task = '', input = {}, multipart = false, provider = 'openai', unknown = false, response, standalone = false, modelName = 'real-model', selected = 'relay-b:model-id'} = {}) {
    const calls = []
    const api = {endpoint: 'https://relay-b.example/v1', key: 'test-secret', provider}
    const handler = (standalone ? createVideoGenerationHandler : createCanvasGenerationHandler)({
        apiForModel: async (model, id) => { assert.equal(model, selected); assert.equal(id, selected); return unknown ? null : api },
        configuredModelFor: () => ({modelName}),
        routeForModel: () => ({provider, protocol: provider === 'gemini' ? 'gemini-generate-content' : provider === 'anthropic' ? 'anthropic-messages' : 'openai-images'}),
        apiUrl: (base, path) => `${base}${path}`,
        geminiEndpointRoot: () => 'https://relay-b.example',
        protocolHeaders: (_, __, json) => ({Authorization: 'Bearer test-secret', ...(json ? {'Content-Type': 'application/json'} : {})}),
        json: async () => input,
        multipartForm: async () => input,
        send: (res, status, payload) => {res.status = status; res.payload = payload},
        fetchImpl: async (url, options) => { calls.push({url: String(url), ...options}); return response || Response.json({id: 'job-1'}) },
    })
    const req = Object.assign(new EventEmitter(), {url: `${standalone ? '/api/videos' : `/api/canvas/${kind}`}${task}?model=${encodeURIComponent(selected)}`, method, headers: {'content-type': multipart ? 'multipart/form-data; boundary=test' : 'application/json'}})
    const res = Object.assign(new EventEmitter(), {req, writeHead(status) {this.status = status}, end(body) {this.body = body; this.writableEnded = true}})
    assert.equal(await handler(req, res), true)
    return {calls, res}
}

test('audio resolves selected relay and replaces internal ID with real model', async () => {
    const {calls, res} = await run({input: {model: 'relay-b:model-id', input: 'hello', voice: 'alloy'}})
    assert.equal(res.status, 200)
    assert.equal(calls[0].url, 'https://relay-b.example/v1/audio/speech')
    assert.equal(JSON.parse(calls[0].body).model, 'real-model')
    assert.equal(calls[0].headers.Authorization, 'Bearer test-secret')
})

test('video multipart preserves media bytes and replaces model ID', async () => {
    const form = new FormData()
    form.set('model', 'relay-b:model-id')
    form.append('image[]', new Blob(['reference'], {type: 'image/png'}), 'ref.png')
    const {calls} = await run({kind: 'video', multipart: true, input: form})
    assert.equal(calls[0].body.get('model'), 'real-model')
    assert.equal(await calls[0].body.get('image[]').text(), 'reference')
    assert.equal(calls[0].headers['Content-Type'], undefined)
})

test('video polling and downloading resolve original model relay', async () => {
    for (const suffix of ['/job-1', '/job-1/content']) {
        const {calls} = await run({kind: 'video', method: 'GET', task: suffix})
        assert.equal(calls[0].url, `https://relay-b.example/v1/videos${suffix}`)
    }
})

test('deleted models fail before any upstream request', async () => {
    const {calls, res} = await run({unknown: true})
    assert.equal(calls.length, 0)
    assert.equal(res.status, 400)
})

test('text dispatches by protocol and normalizes response', async () => {
    for (const provider of ['openai', 'gemini', 'anthropic']) {
        const response = Response.json(provider === 'gemini' ? {candidates: [{content: {parts: [{text: 'answer'}]}}]} : provider === 'anthropic' ? {content: [{text: 'answer'}]} : {choices: [{message: {content: 'answer'}}]})
        const {calls, res} = await run({kind: 'text', provider, response, input: {messages: [{role: 'system', content: 'instructions'}, {role: 'user', content: 'hello'}]}})
        assert.equal(res.payload.text, 'answer')
        assert.match(calls[0].url, provider === 'gemini' ? /real-model:generateContent$/ : provider === 'anthropic' ? /\/messages$/ : /\/chat\/completions$/)
    }
})

test('upstream failures preserve HTTP status and error', async () => {
    const {res} = await run({kind: 'text', response: Response.json({error: {message: 'no channel'}}, {status: 503})})
    assert.equal(res.status, 503)
    assert.equal(res.payload.error, 'no channel')
})

test('Gemini video creation uses native request body and server credentials', async () => {
    const {calls} = await run({kind: 'video', provider: 'gemini', input: {instances: [{prompt: 'hello'}], parameters: {durationSeconds: 8}}})
    assert.match(calls[0].url, /models\/real-model:predictLongRunning$/)
    assert.equal(calls[0].headers['x-goog-api-key'], 'test-secret')
    assert.equal(JSON.parse(calls[0].body).instances[0].prompt, 'hello')
})


test('standalone H3 API overrides legacy protocols and sends only documented JSON', async () => {
    for (const provider of ['openai', 'gemini', 'anthropic']) {
        const {calls} = await run({standalone: true, kind: 'video', modelName: 'Minimax-H3-720p', provider,
            input: {prompt: 'moving camera', seconds: 12, aspect_ratio: '9:16', images: ['https://media.example/ref.png'], metadata: {videos: ['https://media.example/ref.mp4']}, watermark: true, duration: 4}})
        assert.equal(calls.length, 1)
        assert.equal(calls[0].url, 'https://relay-b.example/v1/videos')
        assert.equal(calls[0].headers['Content-Type'], 'application/json')
        assert.deepEqual(JSON.parse(calls[0].body), {model: 'Minimax-H3-720p', prompt: 'moving camera', seconds: 12, ratio: '9:16', images: ['https://media.example/ref.png'], metadata: {video_urls: ['https://media.example/ref.mp4']}})
    }
})

test('standalone H3 polling and content use documented GET endpoints', async () => {
    for (const task of ['/job-1', '/job-1/content']) {
        const {calls} = await run({standalone: true, kind: 'video', modelName: 'Minimax-H3-720p', provider: 'gemini', method: 'GET', task})
        assert.equal(calls.length, 1)
        assert.equal(calls[0].method, 'GET')
        assert.equal(calls[0].url, `https://relay-b.example/v1/videos${task}`)
        assert.equal(calls[0].body, undefined)
    }
})

test('standalone video API rejects unsupported methods before upstream dispatch', async () => {
    const {calls, res} = await run({standalone: true, method: 'DELETE'})
    assert.equal(res.status, 405)
    assert.equal(calls.length, 0)
})

test('documented Seedance model converts canvas multipart to public JSON schema', async () => {
    const form = new FormData()
    form.set('prompt', 'moving camera')
    form.set('seconds', '8')
    form.set('ratio', '9:16')
    form.set('size', '720x1280')
    form.set('watermark', 'false')
    form.append('first_frame', new Blob(['image'], {type: 'image/png'}), 'ref.png')
    const {calls} = await run({standalone: true, modelName: 'doubao-seedance-2-0-260128', input: form, multipart: true})
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://relay-b.example/v1/videos')
    assert.equal(calls[0].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(calls[0].body), {model: 'doubao-seedance-2-0-260128', prompt: 'moving camera', duration: 8, ratio: '9:16', images: ['data:image/png;base64,aW1hZ2U=']})
})

test('Seedance JSON accepts documented duration and image_url; invalid inputs fail', async () => {
    const model = 'doubao-seedance-2-0-260128'
    const input = {prompt: 'test', duration: 8, image_url: 'https://media.example/ref.png'}
    assert.deepEqual(await seedanceVideoPayload(input, model), {model, prompt: 'test', duration: 8, ratio: '16:9', images: [input.image_url]})
    for (const duration of [0, 3, 16, 8.5, 'invalid', undefined]) await assert.rejects(seedanceVideoPayload({...input, duration}, model), /4–15/)
    for (const duration of [4, 15]) assert.equal((await seedanceVideoPayload({...input, duration}, model)).duration, duration)
    await assert.rejects(seedanceVideoPayload({...input, images: Array(10).fill(input.image_url)}, model), /9 张/)
    await assert.rejects(seedanceVideoPayload({...input, metadata: {video_urls: ['https://media.example/ref.mp4']}}, model), /未提供/)
})

test('Seedance preserves upstream 503 and 522 without repeating creation', async () => {
    for (const status of [503, 522]) {
        const response = Response.json({error: {message: 'status_code=522, error code: 522'}}, {status})
        const {calls, res} = await run({standalone: true, modelName: 'doubao-seedance-2-0-260128', input: {prompt: 'test', duration: 8}, response})
        assert.equal(calls.length, 1)
        assert.equal(res.status, status)
        assert.match(res.body.toString(), /522/)
    }
})

test('Seedance polling uses GET and sd2 alias is not silently replaced', async () => {
    for (const task of ['/job-1', '/job-1/content']) {
        const {calls} = await run({standalone: true, modelName: 'doubao-seedance-2-0-260128', method: 'GET', task})
        assert.equal(calls[0].url, `https://relay-b.example/v1/videos${task}`)
        assert.equal(calls[0].body, undefined)
    }
    const {calls} = await run({standalone: true, modelName: 'sd2.0-720p', input: {prompt: 'test', seconds: 8}})
    assert.equal(JSON.parse(calls[0].body).model, 'sd2.0-720p')
})
