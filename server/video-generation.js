// Shared video API for the canvas and standalone video pages.
// Resolve credentials from the selected model for creation, polling and content.
import {isMinimaxH3, minimaxVideoPayload} from './minimax-video.js'
import {isSeedance20, seedanceVideoPayload} from './seedance-video.js'

export function createVideoGenerationHandler({apiForModel, configuredModelFor, routeForModel, apiUrl, geminiEndpointRoot, protocolHeaders, json, multipartForm, send, fetchImpl = fetch}) {
    return async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost')
        const match = url.pathname.match(/^\/api\/(?:videos|canvas\/video)(?:\/([^/]+)(\/content)?)?$/)
        if (!match) return false
        const [, encodedTask, content] = match
        const querying = Boolean(encodedTask)
        if ((querying && req.method !== 'GET') || (!querying && req.method !== 'POST')) {
            send(res, 405, {error: '不支持的请求方法'})
            return true
        }
        const multipart = !querying && /^multipart\//i.test(req.headers['content-type'] || '')
        const input = querying ? {} : multipart ? await multipartForm(req, 50 * 1024 * 1024) : await json(req)
        const selected = String(url.searchParams.get('model') || (multipart ? input.get('model') : input.model) || '').trim()
        if (!selected) {
            send(res, 400, {error: '请选择模型', code: 'MODEL_REQUIRED'})
            return true
        }
        const api = await apiForModel(selected, selected)
        if (!api) {
            send(res, 400, {error: '所选模型所属的 API 配置不存在，请重新选择模型', code: 'MODEL_NOT_FOUND'})
            return true
        }
        const configured = configuredModelFor(api, selected, selected) || configuredModelFor(api, selected)
        if (!configured) {
            send(res, 400, {error: '无法解析所选模型，请刷新模型列表', code: 'MODEL_NOT_FOUND'})
            return true
        }
        const model = configured.modelName
        const route = routeForModel(api, model, selected)
        const h3 = isMinimaxH3(model)
        const seedance = isSeedance20(model)
        const jsonVideo = h3 || seedance
        const gemini = !jsonVideo && (route.provider === 'gemini' || route.protocol.startsWith('gemini'))
        const controller = new AbortController()
        const abort = () => { if (!res.writableEnded) controller.abort() }
        res.on('close', abort)
        req.on('aborted', abort)
        const call = (target, init = {}) => fetchImpl(target, {...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])})
        const geminiTarget = (path) => `${geminiEndpointRoot(api.endpoint)}/v1beta/${path}`
        const headers = jsonVideo ? {Authorization: `Bearer ${api.key}`, 'Content-Type': 'application/json'} : protocolHeaders(api, route, !multipart)
        if (gemini) headers['x-goog-api-key'] = api.key
        try {
            let target
            let body
            if (gemini) {
                if (multipart) {
                    send(res, 400, {error: '模型协议已更新，请重新打开画布后重试'})
                    return true
                }
                if (querying) {
                    const task = decodeURIComponent(encodedTask)
                    if (!/^(?:models\/[^/]+\/)?operations\/[^/?#]+$/.test(task)) {
                        send(res, 400, {error: '视频任务 ID 无效'})
                        return true
                    }
                    target = geminiTarget(task)
                    if (content) {
                        const operation = await call(target, {headers})
                        if (!operation.ok) { await forward(operation, res); return true }
                        const state = await operation.json()
                        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
                        if (!uri) { send(res, 409, {error: state.error?.message || '视频尚未生成完成'}); return true }
                        const download = new URL(uri)
                        // Never send a provider credential to an arbitrary result host.
                        if (download.origin !== new URL(api.endpoint).origin) {
                            send(res, 502, {error: '视频下载地址与配置的服务地址不一致'})
                            return true
                        }
                        const media = await call(download, {headers, redirect: 'error'})
                        await forward(media, res)
                        return true
                    }
                } else {
                    target = geminiTarget(`models/${encodeURIComponent(model)}:predictLongRunning`)
                    body = JSON.stringify({instances: input.instances, parameters: input.parameters})
                }
            } else {
                target = apiUrl(api.endpoint, querying ? `/videos/${encodedTask}${content || ''}` : '/videos')
                if (!querying) {
                    if (jsonVideo) {
                        body = JSON.stringify(await (seedance ? seedanceVideoPayload : minimaxVideoPayload)(input, model))
                        headers['Content-Type'] = 'application/json'
                    }
                    else if (multipart) { input.set('model', model); input.delete('ratio'); input.delete('video_url[]'); input.delete('audio_url[]'); body = input }
                    else body = JSON.stringify({...input, model})
                }
            }
            const upstream = await call(target, {method: req.method, headers, ...(body ? {body} : {})})
            await forward(upstream, res)
            return true
        } finally {
            res.off('close', abort)
            req.off('aborted', abort)
        }
    }
}

async function forward(upstream, res) {
    const buffer = Buffer.from(await upstream.arrayBuffer())
    const origin = res.req?.headers?.origin
    const allowed = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
    res.writeHead(upstream.status, {'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream', 'Access-Control-Allow-Origin': allowed ? origin || 'null' : 'null', 'Vary': 'Origin', 'Cache-Control': 'no-store'})
    res.end(buffer)
}
