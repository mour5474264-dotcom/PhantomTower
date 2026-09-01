import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {createPersonMask, visionStatus, parseDataUrl} from './vision/index.js'

const dataDir = process.env.PHANTOMTOWER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data')
const generatedDir = path.join(dataDir, 'generated')
let exportDir = process.env.PHANTOMTOWER_EXPORT_DIR || path.join(dataDir, 'export')
const files = {
    settings: path.join(dataDir, 'settings.json'),
    records: path.join(dataDir, 'generation-records.json'),
    presets: path.join(dataDir, 'presets.json'),
    builtInPresets: path.join(dataDir, 'builtin-presets.json'),
    promptTemplates: path.join(dataDir, 'prompt-templates.json'),
    defaultPromptTemplates: path.join(dataDir, 'prompt-templates.defaults.json'),
    builtInPromptTemplates: path.join(dataDir, 'builtin-prompt-templates.json'),
    defaultBuiltInPromptTemplates: path.join(dataDir, 'builtin-prompt-templates.defaults.json'),
    promptTemplateHistory: path.join(dataDir, 'prompt-template-history.json'),
    imageCache: path.join(dataDir, 'image-cache.json')
}
const activeGenerations = new Map()
// A single in-flight cache task per remote image URL. Interactive actions can
// await this promise instead of starting a second download.
const pendingImages = new Map()
let recordsWriteQueue = Promise.resolve()
// Development server fallback keeps `npm run server` usable; packaged builds
// always receive a per-user key from Electron's OS-backed safeStorage.
const secretKey = process.env.PHANTOMTOWER_SECRET_KEY || crypto.createHash('sha256').update('phantomtower-development-only').digest('hex')

function encryptionKey() {
    if (!/^[a-f0-9]{64}$/i.test(secretKey)) throw new Error('本地安全存储未初始化，请重启应用')
    return Buffer.from(secretKey, 'hex')
}

function encryptSecret(value) {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`
}

function decryptSecret(value) {
    if (!value) return ''
    if (!String(value).startsWith('v1:')) return String(value)
    const [, ivText, tagText, dataText] = String(value).split(':')
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'))
    decipher.setAuthTag(Buffer.from(tagText, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8')
}

function publicApi(api) {
    if (!api) return api
    const {key, encryptedKey, ...safe} = api
    return {...safe, secretConfigured: Boolean(key || encryptedKey)}
}

function publicSettings(settings) {
    return {
        ...settings,
        apis: Array.isArray(settings.apis) ? settings.apis.map(publicApi) : [],
        storage: {...(settings.storage || {}), exportDir: settings.storage?.exportDir || exportDir}
    }
}

function configuredExportDir(value) {
    const candidate = String(value || '').trim()
    if (!candidate) return path.join(dataDir, 'export')
    if (!path.isAbsolute(candidate)) throw new Error('导出目录必须是绝对路径')
    if (candidate === path.parse(candidate).root) throw new Error('不能使用磁盘根目录作为导出目录')
    return path.resolve(candidate)
}

async function migrateSettings() {
    const current = await read(files.settings, {schemaVersion: 2, apis: [], activeApiId: '', preferences: {}, storage: {}})
    let changed = false
    const apis = Array.isArray(current.apis) ? current.apis.map((api) => {
        const next = {...api}
        if (next.key && !next.encryptedKey) {
            next.encryptedKey = encryptSecret(next.key)
            delete next.key
            changed = true
        }
        if (!next.secretId) { next.secretId = `api-${next.id || crypto.randomUUID()}`; changed = true }
        return next
    }) : []
    if (current.schemaVersion !== 2 || changed) {
        if (changed) await write(`${files.settings}.migration-backup`, current)
        await write(files.settings, {...current, schemaVersion: 2, apis, preferences: current.preferences || {}, storage: current.storage || {}})
    }
    return {...current, schemaVersion: 2, apis}
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function read(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
        return fallback
    }
}

async function write(file, data) {
    await fs.mkdir(path.dirname(file), {recursive: true})
    // Multiple generated images can finish together; each write needs its own temporary file.
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
        await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
        // Windows may briefly deny replacing a file while Defender, an indexer,
        // or the renderer still has the previous handle open.
        for (let attempt = 0; attempt < 16; attempt += 1) {
            try {
                await fs.rename(temporary, file)
                return
            } catch (error) {
                const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                if (!retryable || attempt === 15) throw error
                await wait(Math.min(250, 50 * (attempt + 1)))
            }
        }
    } catch (error) {
        await fs.rm(temporary, {force: true}).catch(() => null)
        throw error
    }
}

function normalizePromptTemplate(template, previous = {}) {
    const now = new Date().toISOString()
    const contentChanged = ['name', 'mode', 'operation', 'systemPrompt', 'defaultNegativePrompt'].some((key) => String(template?.[key] || '') !== String(previous?.[key] || ''))
    return {
        id: String(template?.id || previous.id || crypto.randomUUID()),
        name: String(template?.name || '').trim(),
        mode: ['text', 'image', 'all'].includes(template?.mode) ? template.mode : (previous.mode || 'all'),
        operation: ['all', 'text', 'batch', 'three-view', 'fusion', 'background', 'prop', 'edit'].includes(template?.operation) ? template.operation : (previous.operation || 'all'),
        systemPrompt: String(template?.systemPrompt || ''),
        defaultNegativePrompt: String(template?.defaultNegativePrompt || ''),
        updatedAt: contentChanged || !previous.id ? now : previous.updatedAt,
        version: contentChanged || !previous.id ? Math.max(1, Number(previous.version || 0) + 1) : previous.version
    }
}

function promptTemplateMatches(template, mode, operation) {
    const normalizedOperation = ({
        'local-edit': 'edit',
        reference: 'batch',
        'prop-replace': 'prop'
    })[operation] || operation
    return template && (template.mode === 'all' || template.mode === mode)
        && (!template.operation || template.operation === 'all' || template.operation === normalizedOperation)
}

async function savePromptTemplates(value, targetFile = files.promptTemplates) {
    if (!Array.isArray(value)) throw new Error('prompt templates must be an array')
    const current = await read(targetFile, [])
    const existing = new Map(current.map((item) => [item.id, item]))
    const templates = value.map((item) => normalizePromptTemplate(item, existing.get(item?.id))).filter((item) => {
        if (!item.name || !item.systemPrompt) throw new Error('template name and system prompt are required')
        return true
    })
    const nextById = new Map(templates.map((item) => [item.id, item]))
    const history = await read(files.promptTemplateHistory, [])
    for (const previous of current) {
        const next = nextById.get(previous.id)
        const changed = !next || ['name', 'mode', 'operation', 'systemPrompt', 'defaultNegativePrompt'].some((key) => next[key] !== previous[key])
        if (changed) history.unshift({...previous, archivedAt: new Date().toISOString(), action: next ? 'updated' : 'deleted'})
    }
    await write(files.promptTemplateHistory, history.slice(0, 200))
    await write(targetFile, templates)
    return templates
}

function send(res, status, data) {
    if (res.destroyed) return;
    const origin = res.req?.headers?.origin
    const allowedOrigin = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? (origin || 'null') : 'null'
    res.writeHead(status, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': allowedOrigin, 'Vary': 'Origin'});
    res.end(JSON.stringify(data))
}

async function json(req) {
    let value = '';
    for await (const chunk of req) {
        value += chunk
        if (Buffer.byteLength(value, 'utf8') > 25 * 1024 * 1024) {
            const error = new Error('请求内容过大（上限 25 MB）')
            error.status = 413
            error.code = 'PAYLOAD_TOO_LARGE'
            throw error
        }
    }
    return value ? JSON.parse(value) : {}
}

function apiUrl(endpoint, route) {
    const root = String(endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1(?:\/.*)?$/i, '')
    return `${root}/v1/${String(route).replace(/^\/+/, '')}`
}

function modelId(model) {
    return typeof model === 'string' ? model : model?.id
}

// Model APIs do not have a single standard for image size capabilities. Keep
// the useful, provider-supplied values while avoiding leaking the full model
// object to the renderer.
function modelWithCapabilities(item) {
    if (typeof item === 'string') return {id: item, name: item}
    const id = String(item?.id || item?.name || '').replace(/^models\//, '')
    const rawSizes = item?.supportedSizes || item?.supported_sizes || item?.supported_image_sizes
        || item?.imageSizes || item?.image_sizes || item?.output_sizes || item?.available_sizes
        || item?.capabilities?.sizes || item?.capabilities?.image?.sizes
    const sizes = Array.isArray(rawSizes)
        ? rawSizes.map((value) => typeof value === 'string' ? value : `${value?.width || ''}x${value?.height || ''}`).filter((value) => /^\d+x\d+$/i.test(value))
        : undefined
    return {
        id,
        name: item?.display_name || item?.displayName || id,
        ...(sizes?.length ? {supportedSizes: [...new Set(sizes)]} : {})
    }
}

function geminiModelSource(payload) {
    const candidates = [payload?.models, payload?.data, payload?.model, payload?.data?.models]
    const source = candidates.find((value) => Array.isArray(value) && value.length)
        || candidates.find((value) => Array.isArray(value))
        || []
    return Array.isArray(source) ? source : []
}

function supportsGeminiGeneration(item) {
    const methods = item?.supportedGenerationMethods || item?.supported_generation_methods
    // Relays often omit capability metadata. Do not discard a model merely
    // because the optional field is absent; only filter explicit non-support.
    return !Array.isArray(methods) || methods.length === 0 || methods.includes('generateContent')
}

function geminiModelWithCapabilities(item) {
    if (typeof item === 'string') return modelWithCapabilities(item)
    const name = item?.name || item?.id || item?.model || item?.displayName || item?.display_name
    return modelWithCapabilities({...item, id: name, name})
}

function dataUrlFile(dataUrl, filename = 'reference.png') {
    const parsed = parseDataUrl(dataUrl)
    return new Blob([parsed.buffer], {type: parsed.mimeType || 'image/png'})
}

function referenceFilename(dataUrl, index) {
    const contentType = String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1] || 'image/png'
    return `reference-${index + 1}.${imageExtension(contentType)}`
}

async function upstreamJson(response, context = '上游 API') {
    const text = await response.text()
    if (response.status === 524) {
        const error = new Error(`${context}响应超时（HTTP 524）。上游中转站可能已经接受请求并计费，但未能在规定时间内返回图片；请先到服务商记录确认，不要立即重复提交。`)
        error.code = 'UPSTREAM_524'
        throw error
    }
    try {
        return text ? JSON.parse(text) : {}
    } catch {
        if (response.status === 502 || response.status === 503 || response.status === 504) {
            throw new Error(`${context}暂时不可用（HTTP ${response.status}）。请稍后重试，或检查中转站服务状态。`)
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`${context}鉴权失败（HTTP ${response.status}）。请检查 API Key 和账号权限。`)
        }
        if (response.status === 404) {
            throw new Error(`${context}地址不存在（HTTP 404）。请检查 API 地址和协议配置。`)
        }
        throw new Error(`${context}返回了无法识别的响应（HTTP ${response.status}）。请检查 API 地址、协议和模型是否匹配。`)
    }
}

function apiProvider(api, model = '') {
    const explicit = String(api?.provider || '').trim().toLowerCase()
    if (explicit) return explicit
    const endpoint = String(api?.endpoint || '').toLowerCase()
    // A relay may expose a Gemini model through the OpenAI-compatible API.
    // Do not infer the native Gemini protocol from the model name alone.
    if (endpoint.includes('generativelanguage.googleapis.com') || endpoint.includes('aiplatform.googleapis.com')) return 'gemini'
    return 'openai'
}

// A model name is not a protocol. Relays frequently expose the same model name
// through different APIs, so generation always uses the route recorded by the
// connection test (or a deliberately conservative OpenAI-compatible default).
function detectedRoute(api, model = '') {
    const routes = api?.modelRoutes && typeof api.modelRoutes === 'object' ? api.modelRoutes : {}
    const route = routes[model] || api?.detectedRoute || {}
    const provider = String(route.provider || apiProvider(api, model)).toLowerCase()
    return {
        provider,
        protocol: String(route.protocol || (provider === 'gemini' ? 'gemini-generate-content' : provider === 'anthropic' ? 'anthropic-messages' : 'openai-images')),
        authType: String(route.authType || (provider === 'anthropic' ? 'x-api-key' : provider === 'gemini' ? 'query-key' : 'bearer')),
        imagePath: String(route.imagePath || '/images/generations'),
        editPath: String(route.editPath || '/images/edits'),
        confidence: route.confidence || 'default'
    }
}

function protocolHeaders(api, route, json = true) {
    const headers = json ? {'Content-Type': 'application/json'} : {}
    if (route.authType === 'x-api-key') {
        headers['x-api-key'] = api.key
        headers['anthropic-version'] = '2023-06-01'
    } else if (route.authType !== 'query-key') {
        headers.Authorization = `Bearer ${api.key}`
    }
    return headers
}

function messagesPayload(model, prompt, images = []) {
    const content = [{type: 'text', text: prompt}]
    for (const image of images) {
        const inline = dataUrlParts(image)
        if (inline) content.push({type: 'image', source: {type: 'base64', media_type: inline.mimeType, data: inline.data}})
    }
    return {model, max_tokens: 4096, messages: [{role: 'user', content}]}
}

function messageImages(result) {
    const content = result?.content || result?.data?.content || []
    const images = content.flatMap((part) => {
        const data = part?.source?.data || part?.image?.data || part?.data
        if (!data || typeof data !== 'string') return []
        if (/^https?:\/\//i.test(data)) return [{url: data}]
        return [{b64_json: data.replace(/^data:[^;]+;base64,/, ''), mime_type: part?.source?.media_type || part?.mime_type || 'image/png'}]
    })
    const text = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    for (const url of text.match(/https?:\/\/[^\s)\]"']+/gi) || []) images.push({url})
    return images
}

function geminiUrl(api, model) {
    const endpoint = String(api.endpoint || '').trim().replace(/\/+$/, '')
    const root = endpoint.replace(/\/v1beta$|\/v1$|\/v1alpha$/i, '')
    return `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(api.key)}`
}

function safeEndpoint(value) {
    try {
        const url = new URL(String(value))
        for (const key of ['key', 'api_key', 'apikey', 'token', 'access_token']) url.searchParams.delete(key)
        return url.toString()
    } catch {
        return String(value || '').replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&]*/ig, '$1[已隐藏]')
    }
}

function dataUrlParts(value) {
    const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/s)
    return match ? {mimeType: match[1], data: match[2]} : null
}

// Image providers may wrap a returned URL in Markdown link syntax. Normalize
// it before fetching, caching, persisting, or returning it to the renderer.
function normalizeImageUrl(value) {
    let url = String(value || '').trim()
    if (!url) return ''
    const markdown = url.match(/^!?(?:\[[^\]]*\])\(\s*<?([^>\s]+)>?\s*\)$/i)
    if (markdown?.[1]) url = markdown[1]
    return url.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
}

const GEMINI_ASPECT_RATIOS = [
    {label: '1:1', value: 1},
    {label: '2:3', value: 2 / 3},
    {label: '3:2', value: 3 / 2},
    {label: '3:4', value: 3 / 4},
    {label: '4:3', value: 4 / 3},
    {label: '4:5', value: 4 / 5},
    {label: '5:4', value: 5 / 4},
    {label: '9:16', value: 9 / 16},
    {label: '16:9', value: 16 / 9},
    {label: '21:9', value: 21 / 9}
]

function geminiImageConfig(input) {
    // Gemini uses an image quality tier plus an allowlisted aspect ratio;
    // arbitrary width/height pairs are not part of the native API.
    const config = {}
    const resolution = String(input?.resolution || '').trim().toUpperCase()
    if (['1K', '2K', '4K'].includes(resolution)) config.imageSize = resolution

    const requestedAspectRatio = String(input?.aspectRatio || '').trim()
    if (requestedAspectRatio && requestedAspectRatio.toLowerCase() !== 'auto'
        && GEMINI_ASPECT_RATIOS.some((candidate) => candidate.label === requestedAspectRatio)) {
        config.aspectRatio = requestedAspectRatio
    }
    return config
}

function geminiPayload(input, prompt, images) {
    const parts = [{text: prompt}]
    for (const image of images) {
        const inline = dataUrlParts(image)
        if (inline) parts.push({inlineData: inline})
    }
    const imageConfig = geminiImageConfig(input)
    return {
        contents: [{role: 'user', parts}],
        generationConfig: {
            // Match the native Gemini image examples: the model may return a
            // short text explanation alongside the generated inline image.
            responseModalities: ['TEXT', 'IMAGE'],
            ...(Object.keys(imageConfig).length ? {imageConfig} : {})
        }
    }
}

function geminiImages(result) {
    const images = []
    const addImage = (value, fallbackMimeType = 'image/png') => {
        if (!value) return
        if (typeof value === 'string') {
            if (/^https?:\/\//i.test(value)) images.push({url: value})
            else if (value.trim()) images.push({b64_json: value.replace(/^data:[^;]+;base64,/, ''), mime_type: fallbackMimeType})
            return
        }
        if (Array.isArray(value)) {
            value.forEach((item) => addImage(item, fallbackMimeType))
            return
        }
        if (typeof value !== 'object') return
        const inline = value.inlineData || value.inline_data
        if (inline) {
            const mimeType = inline.mimeType || inline.mime_type || value.mimeType || value.mime_type || fallbackMimeType
            const data = inline.data || inline.base64 || inline.base64Data
            if (data) addImage(typeof data === 'string' ? data : '', mimeType)
            return
        }
        const image = value.image || value.imageData || value.image_data
        if (image) {
            addImage(image, value.mime_type || value.mimeType || fallbackMimeType)
            return
        }
        if (value.images) {
            addImage(value.images, value.mime_type || value.mimeType || fallbackMimeType)
            return
        }
        if (value.output && typeof value.output !== 'string') {
            addImage(value.output, value.mime_type || value.mimeType || fallbackMimeType)
            return
        }
        if (value.data && typeof value.data !== 'string') {
            addImage(value.data, value.mime_type || value.mimeType || fallbackMimeType)
            return
        }
        const data = value.b64_json || value.base64 || value.base64Data || value.data
        const url = value.url || value.image_url?.url || (typeof value.image_url === 'string' ? value.image_url : '')
        if (url) images.push({...value, url})
        else if (typeof data === 'string' && data) images.push({b64_json: data.replace(/^data:[^;]+;base64,/, ''), mime_type: value.mime_type || value.mimeType || fallbackMimeType})
    }

    const parts = result?.candidates?.flatMap((candidate) => candidate?.content?.parts || []) || []
    parts.forEach((part) => addImage(part))
    // Gemini-compatible relays sometimes return OpenAI-style data arrays.
    addImage(result?.data)
    addImage(result?.images)
    addImage(result?.output)
    return images
}

// Keep temporary generation diagnostics useful without dumping full image data
// (or other very large upstream fields) into the renderer console.
function diagnosticValue(value, depth = 0) {
    if (typeof value === 'string') {
        return value.length > 2000 ? `${value.slice(0, 2000)}...[截断，共 ${value.length} 字符]` : value
    }
    if (value === null || typeof value !== 'object') return value
    if (depth >= 4) return Array.isArray(value) ? `[数组，${value.length} 项]` : '[对象已截断]'
    if (Array.isArray(value)) return value.slice(0, 8).map((item) => diagnosticValue(item, depth + 1))
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        /^(?:key|api[_-]?key|token|access[_-]?token|authorization)$/i.test(key) ? '[已隐藏]' : diagnosticValue(item, depth + 1)
    ]))
}

function diagnosticCandidateParts(result) {
    return (result?.candidates || []).flatMap((candidate, candidateIndex) =>
        (candidate?.content?.parts || []).map((part, partIndex) => ({
            candidateIndex,
            partIndex,
            keys: Object.keys(part || {}),
            types: Object.fromEntries(Object.entries(part || {}).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value])),
            inlineDataKeys: part?.inlineData && typeof part.inlineData === 'object' ? Object.keys(part.inlineData) : [],
            inlineDataLength: typeof part?.inlineData?.data === 'string' ? part.inlineData.data.length : 0,
            snakeInlineDataKeys: part?.inline_data && typeof part.inline_data === 'object' ? Object.keys(part.inline_data) : [],
            snakeInlineDataLength: typeof part?.inline_data?.data === 'string' ? part.inline_data.data.length : 0,
            textPreview: typeof part?.text === 'string' ? part.text.slice(0, 300) : ''
        }))
    )
}

function friendlyProviderError(result, status, referenceRequest = false) {
    const raw = typeof result === 'string' ? result : (result?.error?.message || result?.error || result?.message || '')
    const text = String(raw)
    if (/insufficient\s+(?:account\s+)?balance|余额不足|账户余额不足/i.test(text)) {
        return '中转站账户余额不足，Gemini 请求未执行。请为该中转站充值或更换有余额的 API 配置。'
    }
    if (status === 400 && /(?:invalid|unsupported|not supported).{0,80}(?:size|dimension|resolution|width|height)|(?:size|dimension|resolution|width|height).{0,80}(?:invalid|unsupported|not supported)/i.test(text)) {
        return '当前模型或中转站不支持所选图片尺寸。请改用 1K（1024x1024），或选择模型支持的尺寸。'
    }
    if (status === 413) {
        return '图片请求过大，当前模型或中转站无法处理该尺寸或参考图。请改用 1K（1024x1024），或减少参考图数量后重试。'
    }
    if (/images api.*not supported|image api.*not supported|not supported.*images api/i.test(text)) {
        return referenceRequest
            ? '当前中转站不支持图片编辑/图生图接口，请确认该平台提供图生图能力，或更换支持参考图的模型。'
            : '当前中转站不支持图片生成接口，请更换支持图片生成的模型或 API。'
    }
    if (/invalid.*key|api.?key|unauthorized|forbidden/i.test(text) && (status === 401 || status === 403)) return 'API Key 无效或没有权限，请检查密钥和账号套餐。'
    return text || `图片接口调用失败（HTTP ${status}）。请检查 API 地址、协议和模型配置。`
}

function upstreamFetchError(error, context, size = '') {
    const code = String(error?.cause?.code || error?.code || '')
    const sizeText = size ? `（请求尺寸 ${size}）` : ''
    if (error?.generationTimedOut || error?.name === 'AbortError') return `${context}超时${sizeText}。图片生成耗时过长，请稍后重试；也可改用 1K（1024x1024）。`
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `无法解析图片服务地址${sizeText}。请检查网络、DNS 或 API 地址后重试。`
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `无法连接图片服务${sizeText}。请检查网络、代理或中转站状态后重试。`
    return `${context}网络连接失败${sizeText}。请检查网络、代理和中转站状态后重试。`
}

async function fetchImageGeneration(url, options) {
    // Upstream image generation can legitimately take several minutes. Let
    // the caller's AbortSignal control termination instead of imposing a
    // local deadline.
    return fetch(url, {...options, signal: options.signal})
}

function appendGenerationRecord(record) {
    recordsWriteQueue = recordsWriteQueue.catch(() => null).then(async () => {
        const records = await read(files.records, [])
        records.unshift(record)
        await write(files.records, records.slice(0, 500))
    })
    return recordsWriteQueue
}

function deleteGenerationRecord(id) {
    recordsWriteQueue = recordsWriteQueue.catch(() => null).then(async () => {
        const records = await read(files.records, [])
        const next = records.filter((record) => record?.id !== id)
        if (next.length === records.length) return false
        await write(files.records, next)
        return true
    })
    return recordsWriteQueue
}

function deleteAllGenerationRecords() {
    recordsWriteQueue = recordsWriteQueue.catch(() => null).then(async () => {
        const records = await read(files.records, [])
        if (!Array.isArray(records) || records.length === 0) return 0
        await write(files.records, [])
        return records.length
    })
    return recordsWriteQueue
}

function appendGenerationOptions(form, payload, input) {
    form.append('model', String(payload.model))
    form.append('prompt', String(payload.prompt))
    form.append('n', '1')
    form.append('quality', String(payload.quality))
    if (input.size && input.size !== 'auto') form.append('size', input.size)
    if (input.resolution) form.append('resolution', input.resolution)
    if (input.format) form.append('output_format', input.format)
}

function promptTemplateOperation(operation, mode) {
    const aliases = {
        reference: 'batch',
        'prop-replace': 'prop',
        'local-edit': 'edit'
    }
    return aliases[operation] || operation || (mode === 'text' ? 'text' : 'all')
}

async function activeApi() {
    const settings = await migrateSettings();
    const api = settings.apis.find((item) => item.id === settings.activeApiId)
    return api ? {...api, key: decryptSecret(api.encryptedKey)} : null
}

async function fetchModels(api) {
    if (!api?.endpoint || !api?.key) throw new Error('请填写 API 地址和 API Key')
    const provider = apiProvider(api)
    const response = provider === 'gemini'
        ? await fetch(`${String(api.endpoint).replace(/\/+$/, '').replace(/\/v1beta$|\/v1$|\/v1alpha$/i, '')}/v1beta/models?key=${encodeURIComponent(api.key)}`)
        : await fetch(apiUrl(api.endpoint, 'models'), {headers: {Authorization: `Bearer ${api.key}`}})
    const payload = await upstreamJson(response, '模型接口')
    if (provider === 'gemini' && response.ok) {
        const models = geminiModelSource(payload)
            .filter(supportsGeminiGeneration)
            .map(geminiModelWithCapabilities)
        return {status: 200, payload: {data: models}}
    }
    if (response.ok) {
        const source = payload?.data || payload?.models || []
        return {status: response.status, payload: {...payload, data: source.map(modelWithCapabilities)}}
    }
    return {status: response.status, payload}
}

async function detectConnection(api) {
    if (!api?.endpoint || !api?.key) throw new Error('请填写 API 地址和 API Key')
    const endpoint = String(api.endpoint).replace(/\/+$/, '')
    const probes = [
        {
            provider: 'openai', protocol: 'openai-images', authType: 'bearer', imagePath: '/images/generations', editPath: '/images/edits',
            request: () => fetch(apiUrl(endpoint, 'models'), {headers: {Authorization: `Bearer ${api.key}`}}),
            models: (payload) => payload?.data || payload?.models || []
        },
        {
            provider: 'anthropic', protocol: 'anthropic-messages', authType: 'x-api-key', imagePath: '/messages', editPath: '/messages',
            request: () => fetch(apiUrl(endpoint, 'models'), {headers: {'x-api-key': api.key, 'anthropic-version': '2023-06-01'}}),
            models: (payload) => payload?.data || payload?.models || []
        },
        {
            provider: 'gemini', protocol: 'gemini-generate-content', authType: 'query-key', imagePath: '', editPath: '',
            request: () => fetch(`${endpoint.replace(/\/v1beta$|\/v1$|\/v1alpha$/i, '')}/v1beta/models?key=${encodeURIComponent(api.key)}`),
            models: (payload) => geminiModelSource(payload).filter(supportsGeminiGeneration)
        }
    ]
    const requested = String(api.provider || '').toLowerCase()
    const ordered = requested ? [...probes.filter((probe) => probe.provider === requested), ...probes.filter((probe) => probe.provider !== requested)] : probes
    const failures = []
    for (const probe of ordered) {
        let response
        try {
            response = await probe.request()
            const payload = await upstreamJson(response, '模型接口')
            if (!response.ok) {
                failures.push(`${probe.provider}: HTTP ${response.status}`)
                continue
            }
            const models = probe.models(payload).map(modelWithCapabilities)
                .filter((item) => item.id)
            return {
                status: 200,
                payload: {data: models, detection: {...probe, request: undefined, models: undefined, confidence: 'verified', testedAt: new Date().toISOString()}}
            }
        } catch (error) {
            failures.push(`${probe.provider}: ${error.message}`)
        }
    }
    throw new Error(`无法识别中转站协议。已尝试 OpenAI、Anthropic 和 Gemini：${failures.join('；')}`)
}

function cacheKey(url) {
    return crypto.createHash('sha256').update(url).digest('hex')
}

function exportStamp() {
    return `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
}

function imageExtension(contentType) {
    if (/jpe?g/i.test(contentType)) return 'jpg'
    if (/webp/i.test(contentType)) return 'webp'
    if (/gif/i.test(contentType)) return 'gif'
    return 'png'
}

function imageContentType(filename) {
    const extension = path.extname(String(filename || '')).toLowerCase()
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
    if (extension === '.webp') return 'image/webp'
    if (extension === '.gif') return 'image/gif'
    return 'image/png'
}

function detectedImageContentType(buffer, fallback = 'image/png') {
    if (buffer.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg'
    if (buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
    if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
    return fallback
}

function filenameWithImageExtension(filename, contentType) {
    const safeName = String(filename || 'atelier-image').replace(/[^a-zA-Z0-9._-]/g, '_')
    return `${path.basename(safeName, path.extname(safeName)) || 'atelier-image'}.${imageExtension(contentType)}`
}

async function repairStoredImageExtensions() {
    let names
    try {
        names = await fs.readdir(generatedDir)
    } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
    }
    const renamed = new Map()
    for (const name of names) {
        const source = path.join(generatedDir, name)
        let buffer
        try {
            buffer = await fs.readFile(source)
        } catch {
            continue
        }
        const contentType = detectedImageContentType(buffer, imageContentType(name))
        const expected = filenameWithImageExtension(name, contentType)
        if (expected === name) continue
        const target = path.join(generatedDir, expected)
        try {
            await fs.access(target)
            await fs.rm(source)
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
            await fs.rename(source, target)
        }
        renamed.set(name, {filename: expected, contentType})
    }
    if (!renamed.size) return

    const cache = await read(files.imageCache, {})
    for (const entry of Object.values(cache)) {
        const replacement = renamed.get(entry?.filename)
        if (replacement) Object.assign(entry, replacement)
    }
    await write(files.imageCache, cache)

    const records = await read(files.records, [])
    for (const record of records) {
        for (const image of record?.images || []) {
            const replacement = renamed.get(String(image?.url || '').split('/').pop())
            if (replacement) image.url = generatedUrl(replacement.filename)
        }
    }
    await write(files.records, records)
}

function generatedUrl(filename) {
    return `http://127.0.0.1:4317/api/generated/${encodeURIComponent(filename)}`
}

async function resolveRecordImage(image) {
    const currentUrl = normalizeImageUrl(image?.url)
    if (currentUrl.startsWith('http://127.0.0.1:4317/api/generated/')) {
        try {
            const filename = decodeURIComponent(new URL(currentUrl).pathname.slice('/api/generated/'.length))
            await fs.access(path.join(generatedDir, filename))
            return currentUrl === image?.url ? image : {...image, url: currentUrl}
        } catch {
            // Fall through to the durable provider URL or embedded image data.
        }
    } else if (currentUrl || image?.b64_json) {
        return currentUrl === image?.url ? image : {...image, url: currentUrl}
    }
    const sourceUrl = normalizeImageUrl(image?.sourceUrl)
    if (/^https?:\/\//i.test(sourceUrl)) {
        return {...image, url: sourceUrl, sourceUrl}
    }
    if (typeof image?.b64_json === 'string' && image.b64_json) {
        const mimeType = image.mime_type || image.content_type || 'image/png'
        return {...image, url: `data:${mimeType};base64,${image.b64_json}`}
    }
    return image
}

async function resolveRecordImages(records) {
    return Promise.all(records.map(async (record) => {
        const value = record && typeof record === 'object' ? record : {}
        return {
            ...value,
            images: await Promise.all((Array.isArray(value.images) ? value.images : []).map(resolveRecordImage))
        }
    }))
}

async function writeGeneratedImage(filename, buffer) {
    await fs.mkdir(generatedDir, {recursive: true})
    const file = path.join(generatedDir, filename)
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, buffer)
    const saved = await fs.stat(temporary)
    if (!saved.size) throw new Error('generated image is empty')
    try {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            try {
                await fs.rename(temporary, file)
                return file
            } catch (error) {
                const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                if (!retryable || attempt === 15) throw error
                await wait(Math.min(250, 50 * (attempt + 1)))
            }
        }
    } catch (error) {
        await fs.rm(temporary, {force: true}).catch(() => null)
        throw error
    }
}

async function cachedImage(url) {
    const cache = await read(files.imageCache, {})
    const entry = cache[cacheKey(url)]
    if (!entry?.filename) return null
    try {
        const file = path.join(generatedDir, entry.filename)
        await fs.access(file)
        return {...entry, file}
    } catch {
        return null
    }
}

async function cacheImage(url) {
    const existing = await cachedImage(url)
    if (existing) return existing
    let response
    try {
        response = await fetch(url)
    } catch (error) {
        throw error
    }
    if (!response.ok) throw new Error(`image request failed: ${response.status}`)
    const headerContentType = response.headers.get('content-type') || 'image/png'
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = detectedImageContentType(buffer, headerContentType)
    const entry = {filename: `${cacheKey(url)}.${imageExtension(contentType)}`, contentType}
    const file = await writeGeneratedImage(entry.filename, buffer)
    const cache = await read(files.imageCache, {})
    cache[cacheKey(url)] = entry
    await write(files.imageCache, cache)
    return {...entry, file}
}

async function persistImage(url) {
    if (/^data:image\//i.test(url)) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s)
        if (!match) throw new Error('invalid image data')
        const buffer = Buffer.from(match[2], 'base64')
        const contentType = detectedImageContentType(buffer, match[1])
        const filename = `${cacheKey(url)}.${imageExtension(contentType)}`
        const file = path.join(generatedDir, filename)
        await fs.mkdir(generatedDir, {recursive: true})
        try {
            await fs.access(file)
        } catch {
            await writeGeneratedImage(filename, buffer)
        }
        return {filename, contentType, file}
    }
    if (url.startsWith('http://127.0.0.1:4317/api/generated/')) {
        const filename = decodeURIComponent(new URL(url).pathname.slice('/api/generated/'.length))
        const file = path.join(generatedDir, filename)
        await fs.access(file)
        return {filename, contentType: imageContentType(filename), file}
    }
    return cacheImage(url)
}

function cacheImageInBackground(url) {
    const current = pendingImages.get(url)
    if (current) return current
    const task = persistImage(url).finally(() => pendingImages.delete(url))
    pendingImages.set(url, task)
    return task
}

async function externalizeRecordImage(image) {
    const value = {...(image || {})}
    const inlineData = typeof value.b64_json === 'string' && value.b64_json
    if (!inlineData) return value
    // Gemini and some Anthropic relays return image bytes inline. Keep those
    // bytes out of generation-records.json; the record only needs a stable URL.
    if (!value.url || /^data:image\//i.test(value.url)) {
        const contentType = value.mime_type || value.content_type || 'image/png'
        const source = `data:${contentType};base64,${inlineData}`
        const persisted = await cacheImageInBackground(source)
        value.url = generatedUrl(persisted.filename)
    }
    if (/^data:image\//i.test(String(value.sourceUrl || ''))) delete value.sourceUrl
    delete value.b64_json
    return value
}

async function externalizeInlineRecordImages() {
    const records = await read(files.records, [])
    if (!Array.isArray(records)) return
    let changed = false
    const next = await Promise.all(records.map(async (record) => {
        const value = record && typeof record === 'object' ? {...record} : record
        if (!value || !Array.isArray(value.images)) return value
        const images = await Promise.all(value.images.map(async (image) => {
            if (!image?.b64_json) return image
            changed = true
            return externalizeRecordImage(image)
        }))
        return {...value, images}
    }))
    if (changed) await write(files.records, next.slice(0, 500))
}

async function getDownloadImage(url) {
    if (/^data:image\//i.test(url)) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s)
        if (!match) throw new Error('invalid image data')
        const buffer = Buffer.from(match[2], 'base64')
        return {buffer, contentType: detectedImageContentType(buffer, match[1])}
    }
    // Generation stores remote results in the local cache. Reuse that file for
    // exports/downloads so an already available image does not hit the network.
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1:4317/api/generated/')) {
        const local = await cachedImage(url)
        if (local) return {buffer: await fs.readFile(local.file), contentType: local.contentType}
        const pending = pendingImages.get(url)
        if (pending) {
            const entry = await pending
            return {buffer: await fs.readFile(entry.file), contentType: entry.contentType}
        }
    }
    const local = await persistImage(url)
    return {buffer: await fs.readFile(local.file), contentType: local.contentType}
}

try {
    await externalizeInlineRecordImages()
} catch (error) {
    console.error('generation record image migration failed:', error.message)
}
await repairStoredImageExtensions()

const serverPort = Number(process.env.PHANTOMTOWER_PORT || 4317)
http.createServer(async (req, res) => {
    res.req = req
    if (req.method === 'OPTIONS') {
        const origin = req.headers.origin
        const allowedOrigin = !origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ? (origin || 'null') : 'null'
        res.writeHead(204, {'Access-Control-Allow-Origin': allowedOrigin, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Vary': 'Origin'});
        return res.end()
    }
    try {
        if (req.url === '/api/health' && req.method === 'GET') return send(res, 200, {ok: true, dataDir, exportDir})
        if (req.url === '/api/vision/status' && req.method === 'GET') return send(res, 200, await visionStatus())
        if (req.url === '/api/vision/mask' && req.method === 'POST') {
            const input = await json(req)
            if (!input.image) return send(res, 400, {ok: false, error: '目标图不能为空', code: 'INVALID_IMAGE_DATA'})
            try {
                return send(res, 200, {ok: true, ...(await createPersonMask(input.image, input))})
            } catch (error) {
                const status = error.code === 'VISION_MODELS_NOT_INSTALLED' ? 503 : 422
                return send(res, status, {ok: false, error: error.message, code: error.code || 'VISION_FAILED', models: error.models || null})
            }
        }
        if (req.url === '/api/cache/clear' && req.method === 'POST') {
            const entries = await fs.readdir(generatedDir, {withFileTypes: true}).catch(() => [])
            let removed = 0
            for (const entry of entries) {
                if (!entry.isFile()) continue
                await fs.rm(path.join(generatedDir, entry.name), {force: true})
                removed += 1
            }
            return send(res, 200, {ok: true, removed})
        }
        if (req.url.startsWith('/api/generate/cancel') && req.method === 'POST') {
            const taskId = new URL(req.url, 'http://127.0.0.1').searchParams.get('taskId')
            const controller = taskId && activeGenerations.get(taskId)
            if (controller) controller.abort()
            return send(res, 200, {ok: true, cancelled: Boolean(controller)})
        }
        if (req.url === '/api/settings' && req.method === 'GET') {
            return send(res, 200, publicSettings(await migrateSettings()))
        }
        if (req.url === '/api/settings' && req.method === 'POST') {
            const input = await json(req)
            const current = await migrateSettings()
            const incomingApis = Array.isArray(input.apis) ? input.apis : current.apis
            const apis = incomingApis.map((api) => {
                const previous = current.apis.find((item) => item.id === api.id)
                const next = {...api}
                if (next.key) next.encryptedKey = encryptSecret(next.key)
                else if (previous?.encryptedKey) next.encryptedKey = previous.encryptedKey
                delete next.key
                return {...next, secretId: next.secretId || previous?.secretId || `api-${next.id || crypto.randomUUID()}`}
            })
            const nextStorage = input.storage || current.storage || {}
            const nextExportDir = configuredExportDir(nextStorage.exportDir)
            await fs.mkdir(nextExportDir, {recursive: true})
            exportDir = nextExportDir
            await write(files.settings, {
                ...current,
                schemaVersion: 2,
                apis,
                activeApiId: String(input.activeApiId ?? current.activeApiId ?? ''),
                preferences: input.preferences || current.preferences || {},
                storage: {...nextStorage, exportDir: nextExportDir}
            });
            return send(res, 200, {ok: true})
        }
        if (req.url === '/api/presets' && req.method === 'GET') {
            const presets = await read(files.presets, [])
            const builtIns = await read(files.builtInPresets, [])
            return send(res, 200, [...presets, ...builtIns.filter((item) => !presets.some((saved) => saved.id === item.id))])
        }
        if (req.url === '/api/presets' && req.method === 'POST') {
            await write(files.presets, await json(req));
            return send(res, 200, {ok: true})
        }
        if (req.url === '/api/prompt-templates' && req.method === 'GET') {
            return send(res, 200, await read(files.promptTemplates, []))
        }
        if (req.url === '/api/prompt-templates' && req.method === 'POST') {
            return send(res, 200, await savePromptTemplates(await json(req)))
        }
        if (req.url.startsWith('/api/prompt-templates/history') && req.method === 'GET') {
            const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('templateId')
            const history = await read(files.promptTemplateHistory, [])
            return send(res, 200, id ? history.filter((item) => item.id === id) : history)
        }
        if (req.url === '/api/prompt-templates/restore-defaults' && req.method === 'POST') {
            const defaults = await read(files.defaultPromptTemplates, [])
            const restored = await savePromptTemplates(defaults.map((item) => ({...item, version: 0})))
            return send(res, 200, restored)
        }
        if (req.url === '/api/builtin-prompt-templates' && req.method === 'GET') {
            return send(res, 200, await read(files.builtInPromptTemplates, []))
        }
        if (req.url === '/api/builtin-prompt-templates' && req.method === 'POST') {
            return send(res, 200, await savePromptTemplates(await json(req), files.builtInPromptTemplates))
        }
        if (req.url === '/api/builtin-prompt-templates/restore-defaults' && req.method === 'POST') {
            const defaults = await read(files.defaultBuiltInPromptTemplates, [])
            return send(res, 200, await savePromptTemplates(defaults.map((item) => ({...item, version: 0})), files.builtInPromptTemplates))
        }
        if (req.url === '/api/records' && req.method === 'GET') {
            const records = await read(files.records, [])
            return send(res, 200, await resolveRecordImages(Array.isArray(records) ? records : []))
        }
        if (req.url === '/api/records' && req.method === 'DELETE') {
            const count = await deleteAllGenerationRecords()
            return send(res, 200, {ok: true, count})
        }
        const recordMatch = req.url.match(/^\/api\/records\/([^/?]+)$/)
        if (recordMatch && req.method === 'DELETE') {
            const id = decodeURIComponent(recordMatch[1])
            if (!await deleteGenerationRecord(id)) return send(res, 404, {error: 'generation record not found'})
            return send(res, 200, {ok: true})
        }
        if (req.url.startsWith('/api/generated/') && req.method === 'GET') {
            const name = decodeURIComponent(req.url.slice('/api/generated/'.length)).replace(/[^a-zA-Z0-9._-]/g, '')
            if (!name || name.includes('..')) return send(res, 400, {error: 'invalid generated file'})
            try {
                const file = path.join(generatedDir, name)
                const buffer = await fs.readFile(file)
                const type = imageContentType(name)
                res.writeHead(200, {
                    'Content-Type': type,
                    'Cache-Control': 'public, max-age=31536000',
                    'Access-Control-Allow-Origin': 'null'
                })
                return res.end(buffer)
            } catch {
                return send(res, 404, {error: 'generated file not found'})
            }
        }
        if (req.url.startsWith('/api/download') && req.method === 'GET') {
            const params = new URL(req.url, 'http://127.0.0.1').searchParams;
            const target = params.get('url');
            const filename = (params.get('filename') || 'atelier-image.png').replace(/[^a-zA-Z0-9._-]/g, '_');
            if (!target || !/^https?:/.test(target)) return send(res, 400, {error: 'invalid url'});
            const image = await getDownloadImage(target);
            res.writeHead(200, {
                'Content-Type': image.contentType || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Access-Control-Allow-Origin': 'null'
            });
            return res.end(image.buffer)
        }
        if (req.url === '/api/save-image' && req.method === 'POST') {
            const {url, filename = 'atelier-image.png'} = await json(req)
            if (!url || typeof url !== 'string') return send(res, 400, {error: 'invalid image url'})
            const image = await getDownloadImage(url)
            const safeName = filenameWithImageExtension(filename, image.contentType)
            await fs.mkdir(exportDir, {recursive: true})
            const target = path.join(exportDir, safeName)
            await fs.writeFile(target, image.buffer)
            return send(res, 200, {ok: true, path: target, filename: safeName, exportDir})
        }
        if (req.url === '/api/prepare-edit' && req.method === 'POST') {
            const {url} = await json(req)
            if (!url || typeof url !== 'string') return send(res, 400, {error: 'invalid image url'})
            const image = await persistImage(url)
            return send(res, 200, {
                ok: true,
                url: generatedUrl(image.filename),
                filename: image.filename,
                contentType: image.contentType
            })
        }
        if (req.url === '/api/export' && req.method === 'POST') {
            const {urls = []} = await json(req)
            if (!urls.length) return send(res, 400, {error: '请选择图片'})
            const batch = exportStamp()
            await fs.mkdir(exportDir, {recursive: true})
            const saved = await Promise.all(urls.map(async (url, index) => {
                const image = await getDownloadImage(url)
                const filename = filenameWithImageExtension(`phantom-tower-${batch}-${index + 1}`, image.contentType)
                const target = path.join(exportDir, filename)
                await fs.writeFile(target, image.buffer)
                return {filename, path: target}
            }))
            return send(res, 200, {ok: true, count: saved.length, files: saved, exportDir})
        }
        if (req.url === '/api/models' && req.method === 'GET') {
            const api = await activeApi();
            if (!api) return send(res, 400, {error: '请先配置并启用 API'});
            const result = await fetchModels(api)
            return send(res, result.status, result.payload)
        }
        if (req.url === '/api/models/test' && req.method === 'POST') {
            const input = await json(req)
            const settings = await migrateSettings()
            const stored = settings.apis.find((item) => item.id === input.id)
            const api = {...stored, ...input, key: input.key || decryptSecret(stored?.encryptedKey)}
            const result = await detectConnection(api)
            if (result.status === 200 && api.id) {
                const detection = result.payload.detection
                const models = result.payload.data || []
                const nextApis = settings.apis.map((item) => item.id === api.id ? {
                    ...item,
                    provider: detection.provider,
                    detectedRoute: {
                        provider: detection.provider,
                        protocol: detection.protocol,
                        authType: detection.authType,
                        imagePath: detection.imagePath,
                        editPath: detection.editPath,
                        confidence: detection.confidence,
                        testedAt: detection.testedAt
                    },
                    modelRoutes: Object.fromEntries(models.map((model) => [model.id, {
                        provider: detection.provider,
                        protocol: detection.protocol,
                        authType: detection.authType,
                        imagePath: detection.imagePath,
                        editPath: detection.editPath,
                        confidence: detection.confidence,
                        testedAt: detection.testedAt
                    }]))
                } : item)
                await write(files.settings, {...settings, apis: nextApis})
            }
            return send(res, result.status, result.payload)
        }
        if (req.url === '/api/generate' && req.method === 'POST') {
            const input = await json(req);
            const api = await activeApi();
            const requestedImages = Array.isArray(input.images) ? input.images.filter((image) => typeof image === 'string' && image.trim()) : []
            const mode = input.mode === 'image' ? 'image' : 'text'
            // UI task types describe the image role, while templates are keyed by
            // the user-facing operation. Normalize them before resolving presets.
            const operation = promptTemplateOperation(input.operation, mode)
            const builtIns = await read(files.builtInPromptTemplates, [])
            const builtIn = builtIns.find((item) => promptTemplateMatches(item, mode, operation))
            const templates = await read(files.promptTemplates, [])
            const userTemplate = input.presetId ? templates.find((item) => item.id === input.presetId) : null
            if (input.presetId && !userTemplate) return send(res, 400, {error: '所选提示词预设不存在'})
            // Presets improve consistency but are optional. A user-entered prompt
            // must be enough to generate an image when no matching preset exists.
            const finalPrompt = [builtIn?.systemPrompt, builtIn?.defaultNegativePrompt && `负向提示词：${builtIn.defaultNegativePrompt}`, input.prompt, userTemplate?.systemPrompt, userTemplate?.defaultNegativePrompt && `负向提示词：${userTemplate.defaultNegativePrompt}`, input.extraPrompt]
                .filter((value) => typeof value === 'string' && value.trim()).join('\n\n')
            if (!api) return send(res, 400, {error: '请先配置并启用 API'})
            const controller = new AbortController();
            req.on('aborted', () => controller.abort())
            const images = []
            const responses = []
            const debugResponses = []
            for (let index = 0; index < Math.max(1, Number(input.n || 1)); index += 1) {
                if (controller.signal.aborted) break
                const route = detectedRoute(api, input.model)
                const provider = route.provider
                const payload = {
                    model: input.model,
                    prompt: finalPrompt,
                    n: 1,
                    quality: 'high',
                    response_format: 'url'
                }
                if (input.size && input.size !== 'auto') payload.size = input.size
                if (input.resolution) payload.resolution = input.resolution
                if (input.format) payload.output_format = input.format
                if (input.mask) payload.mask = input.mask
                const referenceImages = requestedImages
                if (Array.isArray(input.materials) && input.materials.length) {
                    payload.materials = input.materials.map(({data, ...material}) => material)
                }
                const isReferenceRequest = referenceImages.length > 0
                const imagePath = isReferenceRequest ? route.editPath : route.imagePath
                let body = JSON.stringify(payload)
                let headers = protocolHeaders(api, route)
                if (route.protocol === 'anthropic-messages') {
                    // The connection test records Anthropic relays as Messages APIs.
                    // Keep generation on that protocol instead of sending an
                    // OpenAI Images request to the same endpoint.
                    body = JSON.stringify(messagesPayload(input.model, finalPrompt, referenceImages))
                } else if (isReferenceRequest && route.protocol === 'openai-images') {
                    const form = new FormData()
                    appendGenerationOptions(form, payload, input)
                    for (const [imageIndex, image] of referenceImages.entries()) {
                        form.append('image[]', dataUrlFile(image), referenceFilename(image, imageIndex))
                    }
                    if (input.mask) form.append('mask', dataUrlFile(input.mask, 'person-mask.png'), 'person-mask.png')
                    form.append('input_fidelity', 'high')
                    body = form
                    headers = protocolHeaders(api, route, false)
                }
                if (provider === 'gemini') {
                    if (isReferenceRequest) {
                        // Gemini accepts reference images as inlineData parts in the same request.
                        body = JSON.stringify(geminiPayload(input, finalPrompt, referenceImages))
                    } else {
                        body = JSON.stringify(geminiPayload(input, finalPrompt, []))
                    }
                    headers = protocolHeaders(api, route)
                }
                const activeTaskId = String(input.taskId || crypto.randomUUID())
                activeGenerations.set(activeTaskId, controller)
                let response
                let result
                let responseProvider = provider
                try {
                    response = await fetchImageGeneration(provider === 'gemini' ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath), {
                        method: 'POST', headers, body, signal: controller.signal
                    })
                } catch (error) {
                    return send(res, 504, {
                        error: upstreamFetchError(error, '图片生成接口', input.size),
                        code: String(error?.cause?.code || error?.code || 'UPSTREAM_FETCH_ERROR'),
                        original: {name: error?.name || '', code: error?.cause?.code || error?.code || '', message: error?.cause?.message || error?.message || ''},
                        provider,
                        hint: `本次请求尺寸为 ${input.size || '默认尺寸'}；请确认当前模型支持该尺寸。`
                    })
                } finally {
                    activeGenerations.delete(activeTaskId)
                }
                try {
                    result = await upstreamJson(response, `${provider} 图片接口`)
                } catch (error) {
                        return send(res, response.ok ? 502 : response.status, {
                            error: error.message,
                            code: error.code || 'UPSTREAM_RESPONSE_ERROR',
                            generationAcceptedUnknown: error.code === 'UPSTREAM_524',
                            provider,
                            endpoint: safeEndpoint(provider === 'gemini' ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath)),
                            upstream: diagnosticValue(result),
                            hint: isReferenceRequest ? '当前请求包含参考图，请确认该平台支持图生图接口或 Gemini 图片输入。' : '请确认接口地址是 API 根地址，而不是网站首页。'
                        })
                }
                const errorText = JSON.stringify(result).toLowerCase()
                const canRetryGemini = provider === 'openai'
                    && /gemini/i.test(String(input.model || ''))
                    && /images api.*not supported|not supported.*images api|image api.*not supported/.test(errorText)
                if (!response.ok && canRetryGemini) {
                    responseProvider = 'gemini'
                    try {
                        response = await fetchImageGeneration(geminiUrl(api, input.model), {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify(geminiPayload(input, finalPrompt, referenceImages)),
                            signal: controller.signal
                        })
                    } catch (error) {
                        return send(res, 504, {
                            error: upstreamFetchError(error, 'Gemini 回退接口', input.size),
                            provider: 'gemini',
                            hint: `本次请求尺寸为 ${input.size || '默认尺寸'}；请确认 Gemini 接口地址、网络和中转站状态。`
                        })
                    }
                    try {
                        result = await upstreamJson(response, 'Gemini 回退接口')
                    } catch (error) {
                        return send(res, response.ok ? 502 : response.status, {error: error.message, code: error.code || 'UPSTREAM_RESPONSE_ERROR', generationAcceptedUnknown: error.code === 'UPSTREAM_524', provider: 'gemini', endpoint: safeEndpoint(geminiUrl(api, input.model)), upstream: diagnosticValue(result), hint: '中转站不支持 OpenAI Images API，且 Gemini 原生接口也未返回 JSON，请核对该中转站的 Gemini 接口地址。'})
                    }
                }
                if (!response.ok) return send(res, response.status, {
                    error: friendlyProviderError(result, response.status, isReferenceRequest),
                    code: `UPSTREAM_HTTP_${response.status}`,
                    status: response.status,
                    provider: responseProvider,
                    endpoint: safeEndpoint(responseProvider === 'gemini' ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath)),
                    upstream: diagnosticValue(result),
                    hint: isReferenceRequest ? '当前请求包含参考图，请确认模型支持人物替换/图生图，并检查参考图尺寸。' : `当前请求尺寸为 ${input.size || '默认尺寸'}；请确认模型支持该尺寸。`
                })
                const normalizedData = responseProvider === 'gemini'
                    ? geminiImages(result)
                    : route.protocol === 'anthropic-messages'
                        ? messageImages(result)
                        : (result.data || [])
                if (input.debug) {
                    let maskBytes = 0
                    if (input.mask && isReferenceRequest && route.protocol === 'openai-images') {
                        try { maskBytes = parseDataUrl(input.mask).buffer.length } catch { maskBytes = 0 }
                    }
                    debugResponses.push({
                        iteration: index + 1,
                        provider: responseProvider,
                        protocol: route.protocol,
                        imageConfig: responseProvider === 'gemini' ? geminiImageConfig(input) : null,
                        editPath: imagePath,
                        requestBody: body instanceof FormData ? 'multipart/form-data' : 'application/json',
                        maskAttached: Boolean(maskBytes),
                        maskBytes,
                        httpStatus: response.status,
                        responseKeys: result && typeof result === 'object' ? Object.keys(result) : [],
                        normalizedImageCount: normalizedData.length,
                        candidateParts: diagnosticCandidateParts(result),
                        upstream: diagnosticValue(result)
                    })
                }
                if (!normalizedData.length) {
                    return send(res, 502, {
                        error: '图片接口返回成功，但响应中没有可识别的图片数据',
                        code: 'UPSTREAM_NO_IMAGE_DATA',
                        provider: responseProvider,
                        endpoint: safeEndpoint(responseProvider === 'gemini' ? geminiUrl(api, input.model) : apiUrl(api.endpoint, imagePath)),
                        responseKeys: result && typeof result === 'object' ? Object.keys(result) : [],
                        hint: '请检查中转站是否返回 inlineData/inline_data、data[].b64_json 或图片 URL。',
                        upstream: diagnosticValue(result)
                    })
                }
                responses.push({
                    usage: result.usage || null,
                    revisedPrompts: normalizedData.map((item) => item.revised_prompt).filter(Boolean)
                })
                images.push(...normalizedData)
            }
            if (controller.signal.aborted) return
            // Return the provider URL immediately so the browser can display it.
            // Cache each result in the background; save/edit/export operations wait
            // on the same pending promise through getDownloadImage().
            const persistedImages = images.map((image) => {
                const contentType = image?.mime_type || image?.content_type || 'image/png'
                const source = normalizeImageUrl(image?.url) || (image?.b64_json ? `data:${contentType};base64,${image.b64_json}` : '')
                if (!source) return image
                cacheImageInBackground(source).catch((error) => {
                    console.error('image cache failed:', error.message)
                })
                return {...image, url: source, sourceUrl: normalizeImageUrl(image.url) || source}
            })
            const recordImages = await Promise.all(persistedImages.map(async (image) => ({
                ...(await externalizeRecordImage(image)),
                id: crypto.randomUUID(),
                taskId: input.taskId || null,
                parentResultId: input.parentResultId || null,
                version: Math.max(1, Number(input.version || 1))
            })))
            const responseImages = persistedImages.map((image, index) => {
                if (!image?.b64_json || !recordImages[index]?.url) return image
                const value = {...image, url: recordImages[index].url, sourceUrl: recordImages[index].url}
                delete value.b64_json
                return value
            })
            const record = {
                id: Date.now().toString(),
                createdAt: new Date().toISOString(),
                model: input.model,
                prompt: input.extraPrompt || '',
                request: {
                    taskId: input.taskId || crypto.randomUUID(),
                    parentResultId: input.parentResultId || null,
                    version: Math.max(1, Number(input.version || 1)),
                    operation,
                    effectivePrompt: finalPrompt,
                    presetId: userTemplate?.id || null,
                    builtinPresetId: builtIn?.id || null,
                    imageCount: input.images?.length || 0,
                    materials: (input.materials || []).map((item, index) => ({
                        index: index + 1,
                        role: item.role || 'reference',
                        type: item.type
                    }))
                },
                responses,
                images: recordImages
            }
            await appendGenerationRecord(record)
            const payload = {created: Date.now(), data: responseImages}
            if (input.debug) {
                payload.debug = {
                    note: '仅用于排查，字符串最长 2000 字符，深度和数组长度均有限制',
                    requestedModel: input.model,
                    provider: debugResponses[debugResponses.length - 1]?.provider || null,
                    normalizedImageCount: images.length,
                    responses: debugResponses
                }
            }
            return send(res, 200, payload)
        }
        send(res, 404, {error: 'Not found'})
    } catch (error) {
        if (error.name !== 'AbortError') {
            console.error(`[${req.method} ${req.url}] ${error.stack || error.message}`)
            send(res, error.status || 500, {error: error.message, code: error.code || 'LOCAL_SERVER_ERROR'})
        }
    }
}).listen(serverPort, '127.0.0.1', () => console.log(`PhantomTower local server: http://127.0.0.1:${serverPort}`))



