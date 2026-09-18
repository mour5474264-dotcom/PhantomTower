// Canvas text/audio generation; legacy video URLs delegate to the shared video API.
import {isMinimaxH3} from './minimax-video.js'
import {createVideoGenerationHandler} from './video-generation.js'

export function createCanvasGenerationHandler({apiForModel, configuredModelFor, routeForModel, apiUrl, geminiEndpointRoot, protocolHeaders, json, multipartForm, send, fetchImpl = fetch}) {
    const videoHandler = createVideoGenerationHandler({apiForModel, configuredModelFor, routeForModel, apiUrl, geminiEndpointRoot, protocolHeaders, json, multipartForm, send, fetchImpl})
    return async function handle(req, res) {
        if (await videoHandler(req, res)) return true
        const url = new URL(req.url, 'http://localhost')
        const match = url.pathname.match(/^\/api\/canvas\/(text|audio)(?:\/([^/]+)(\/content)?)?$/)
        if (!match) return false
        const [, kind, encodedTask] = match
        if (encodedTask || req.method !== 'POST') {
            send(res, 405, {error: '不支持的请求方法'})
            return true
        }
        const input = await json(req)
        const selected = String(url.searchParams.get('model') || input.model || '').trim()
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
        if (isMinimaxH3(model)) {
            send(res, 400, {error: 'Minimax-H3 是视频生成模型，请切换到“视频”；参考音频不代表支持语音合成'})
            return true
        }
        const route = routeForModel(api, model, selected)
        const gemini = route.provider === 'gemini' || route.protocol.startsWith('gemini')
        const controller = new AbortController()
        const abort = () => { if (!res.writableEnded) controller.abort() }
        res.on('close', abort)
        req.on('aborted', abort)
        const call = (target, init = {}) => fetchImpl(target, {...init, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600000)])})
        const geminiTarget = (path) => `${geminiEndpointRoot(api.endpoint)}/v1beta/${path}`
        const headers = protocolHeaders(api, route, true)
        if (gemini) headers['x-goog-api-key'] = api.key
        try {
            let target
            let body
            if (kind === 'text') {
                const messages = Array.isArray(input.messages) ? input.messages : []
                const parts = (message) => typeof message.content === 'string' ? [{type: 'text', text: message.content}] : message.content || []
                const inline = (part) => {
                    const match = String(part.image_url?.url || '').match(/^data:([^;]+);base64,(.+)$/s)
                    if (!match) throw Object.assign(new Error('参考图片必须转换为 base64 data URL'), {status: 400})
                    return {mimeType: match[1], data: match[2]}
                }
                const system = messages.filter((item) => item.role === 'system').flatMap(parts).map((part) => part.text || '').join('\n')
                if (gemini) {
                    target = geminiTarget(`models/${encodeURIComponent(model)}:generateContent`)
                    body = {contents: messages.filter((item) => item.role !== 'system').map((message) => ({role: message.role === 'assistant' ? 'model' : 'user', parts: parts(message).map((part) => part.type === 'text' ? {text: part.text} : {inlineData: inline(part)})})), ...(system ? {systemInstruction: {parts: [{text: system}]}} : {})}
                } else if (route.protocol === 'anthropic-messages') {
                    target = apiUrl(api.endpoint, '/messages')
                    body = {model, max_tokens: 4096, ...(system ? {system} : {}), messages: messages.filter((item) => item.role !== 'system').map((message) => ({...message, content: parts(message).map((part) => {
                        if (part.type === 'text') return part
                        const image = inline(part)
                        return {type: 'image', source: {type: 'base64', media_type: image.mimeType, data: image.data}}
                    })}))}
                } else {
                    target = apiUrl(api.endpoint, '/chat/completions')
                    body = {model, messages, stream: false, ...(input.reasoningEffort && input.reasoningEffort !== 'auto' ? {reasoning_effort: input.reasoningEffort} : {})}
                }
                const upstream = await call(target, {method: 'POST', headers, body: JSON.stringify(body)})
                const raw = await upstream.text()
                let payload
                try { payload = JSON.parse(raw) } catch { payload = {error: {message: raw.slice(0, 1000) || '上游返回了空响应'}} }
                if (!upstream.ok || payload.error) {
                    send(res, upstream.ok ? 502 : upstream.status, {error: payload.error?.message || payload.error || payload.message || '文本生成失败'})
                    return true
                }
                const result = gemini ? payload.candidates?.[0]?.content?.parts : route.protocol === 'anthropic-messages' ? payload.content : payload.choices?.[0]?.message?.content
                const text = typeof result === 'string' ? result : (result || []).map((part) => part.text || '').join('')
                send(res, text ? 200 : 502, text ? {text} : {error: '上游没有返回文本内容'})
                return true
            }
            if (kind === 'audio') {
                if (gemini || route.protocol === 'anthropic-messages') {
                    send(res, 400, {error: '当前语音生成支持 OpenAI 兼容的 /audio/speech 接口，请选择对应模型'})
                    return true
                }
                target = apiUrl(api.endpoint, '/audio/speech')
                body = JSON.stringify({...input, model})
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
