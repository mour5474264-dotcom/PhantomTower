import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {isMinimaxH3, minimaxVideoPayload} from '../server/minimax-video.js'

test('H3 sends documented JSON fields, inline images and metadata URLs', async () => {
    const form = new FormData()
    form.set('prompt', 'moving camera')
    form.set('seconds', '12')
    form.set('ratio', '9:16')
    form.set('watermark', 'false')
    form.append('first_frame', new Blob(['image'], {type: 'image/png'}), 'ref.png')
    form.append('video[]', new Blob(['video']), 'ref.mp4')
    form.append('video_url[]', 'https://media.example/ref.mp4')
    const result = await minimaxVideoPayload(form, 'Minimax-H3-720p')
    assert.deepEqual(result, {model: 'Minimax-H3-720p', prompt: 'moving camera', seconds: 12, ratio: '9:16', images: ['data:image/png;base64,aW1hZ2U='], metadata: {video_urls: ['https://media.example/ref.mp4']}})
})

test('H3 duration is an integer within 10–15 seconds and unsupported ratios fail', async () => {
    const form = new FormData()
    form.set('prompt', 'test')
    for (const [input, output] of [['4', 10], ['12.7', 13], ['20', 15], ['', 10]]) {
        form.set('seconds', input)
        assert.equal((await minimaxVideoPayload(form, 'Minimax-H3-720p')).seconds, output)
    }
    form.set('ratio', '7:9')
    await assert.rejects(minimaxVideoPayload(form, 'Minimax-H3-720p'), /画幅/)
})

test('local media and excess references fail before dispatch', async () => {
    const form = new FormData()
    form.set('prompt', 'test')
    form.append('audio[]', new Blob(['audio']), 'a.mp3')
    await assert.rejects(minimaxVideoPayload(form, 'Minimax-H3-720p'), /HTTPS/)
    form.delete('audio[]')
    for (let i = 0; i < 10; i++) form.append('image[]', new Blob(['image']), 'ref.png')
    await assert.rejects(minimaxVideoPayload(form, 'Minimax-H3-720p'), /9 张图片/)
    assert.equal(isMinimaxH3('gpt-image-2'), false)
})

test('video response parser accepts relay task_id and existing id responses', () => {
    const source = stripTypeScriptTypes(readFileSync(new URL('../src/canvas/services/api/video.ts', import.meta.url), 'utf8'))
    const start = source.indexOf('function unwrapVideoResponse(')
    const end = source.indexOf('function videoResultUrl(', start)
    const parse = vm.runInNewContext(`${source.slice(start, end)}; unwrapVideoResponse`, {apiText: (key) => key, readApiErrorMessage: () => 'error'})
    assert.equal(parse({task_id: 'h3-1'}).id, 'h3-1')
    assert.equal(parse({data: {task_id: 'h3-2', status: 'SUCCEEDED'}}).status, 'succeeded')
    assert.equal(parse({code: 0, data: {task_id: 'h3-3'}}).id, 'h3-3')
    assert.equal(parse({id: 'old-1'}).id, 'old-1')
})
