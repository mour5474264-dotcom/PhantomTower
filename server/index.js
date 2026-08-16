import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'

const dataDir = process.env.PHANTOMTOWER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data')
const generatedDir = path.join(dataDir, 'generated')
const exportDir = process.env.PHANTOMTOWER_EXPORT_DIR || path.join(dataDir, 'exports')
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
const pendingImages = new Map()
const activeGenerations = new Map()
// `/v1/models` does not expose reference-image capabilities. Only expose models
// proven to consume reference images through the configured gateway.
const referenceImageModels = new Set(['gpt-image-2-1k'])

async function read(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch {
        return fallback
    }
}

async function write(file, data) {
    await fs.mkdir(dataDir, {recursive: true})
    // Multiple generated images can finish together; each write needs its own temporary file.
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(temporary, file)
}

function normalizePromptTemplate(template, previous = {}) {
    const now = new Date().toISOString()
    const contentChanged = ['name', 'mode', 'operation', 'systemPrompt', 'defaultNegativePrompt'].some((key) => String(template?.[key] || '') !== String(previous?.[key] || ''))
    return {
        id: String(template?.id || previous.id || crypto.randomUUID()),
        name: String(template?.name || '').trim(),
        mode: ['text', 'image', 'all'].includes(template?.mode) ? template.mode : (previous.mode || 'all'),
        operation: ['all', 'text', 'batch', 'fusion', 'background', 'prop', 'edit'].includes(template?.operation) ? template.operation : (previous.operation || 'all'),
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
    res.writeHead(status, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'});
    res.end(JSON.stringify(data))
}

async function json(req) {
    let value = '';
    for await (const chunk of req) value += chunk;
    return value ? JSON.parse(value) : {}
}

function apiUrl(endpoint, route) {
    const root = String(endpoint || '').trim().replace(/\/+$/, '')
    return `${root}/v1/${String(route).replace(/^\/+/, '')}`
}

function modelId(model) {
    return typeof model === 'string' ? model : model?.id
}

function supportsReferenceImages(model) {
    return referenceImageModels.has(modelId(model))
}

function filterReferenceImageModels(payload) {
    const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
    const supported = models.filter(supportsReferenceImages)
    return Array.isArray(payload?.data) ? {...payload, data: supported} : {...payload, models: supported}
}

function dataUrlFile(dataUrl, filename = 'reference.png') {
    const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/s)
    if (!match) throw new Error('invalid reference image data')
    return new Blob([Buffer.from(match[2], 'base64')], {type: match[1] || 'image/png'})
}

function referenceFilename(dataUrl, index) {
    const contentType = String(dataUrl || '').match(/^data:([^;]+);base64,/i)?.[1] || 'image/png'
    return `reference-${index + 1}.${imageExtension(contentType)}`
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
    const settings = await read(files.settings, {apis: [], activeApiId: ''});
    return settings.apis.find((item) => item.id === settings.activeApiId)
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
    return 'png'
}

function generatedUrl(filename) {
    return `http://127.0.0.1:4317/api/generated/${encodeURIComponent(filename)}`
}

async function writeGeneratedImage(filename, buffer) {
    await fs.mkdir(generatedDir, {recursive: true})
    const file = path.join(generatedDir, filename)
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temporary, buffer)
    const saved = await fs.stat(temporary)
    if (!saved.size) throw new Error('generated image is empty')
    await fs.rename(temporary, file)
    return file
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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    let response
    try {
        response = await fetch(url, {signal: controller.signal})
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('image cache request timed out')
        throw error
    } finally {
        clearTimeout(timeout)
    }
    if (!response.ok) throw new Error(`image request failed: ${response.status}`)
    const contentType = response.headers.get('content-type') || 'image/png'
    const entry = {filename: `${cacheKey(url)}.${imageExtension(contentType)}`, contentType}
    const file = await writeGeneratedImage(entry.filename, Buffer.from(await response.arrayBuffer()))
    const cache = await read(files.imageCache, {})
    cache[cacheKey(url)] = entry
    await write(files.imageCache, cache)
    return {...entry, file}
}

function saveImageInBackground(url) {
    const current = pendingImages.get(url)
    if (current) return current
    const task = persistImage(url).finally(() => pendingImages.delete(url))
    pendingImages.set(url, task)
    return task
}

async function persistImage(url) {
    if (/^data:image\//i.test(url)) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s)
        if (!match) throw new Error('invalid image data')
        const contentType = match[1]
        const filename = `${cacheKey(url)}.${imageExtension(contentType)}`
        const file = path.join(generatedDir, filename)
        await fs.mkdir(generatedDir, {recursive: true})
        try {
            await fs.access(file)
        } catch {
            await writeGeneratedImage(filename, Buffer.from(match[2], 'base64'))
        }
        return {filename, contentType, file}
    }
    if (url.startsWith('http://127.0.0.1:4317/api/generated/')) {
        const filename = decodeURIComponent(new URL(url).pathname.slice('/api/generated/'.length))
        const file = path.join(generatedDir, filename)
        await fs.access(file)
        return {filename, contentType: filename.endsWith('.jpg') || filename.endsWith('.jpeg') ? 'image/jpeg' : filename.endsWith('.webp') ? 'image/webp' : 'image/png', file}
    }
    return pendingImages.get(url) || cacheImage(url)
}

async function getDownloadImage(url) {
    if (/^data:image\//i.test(url)) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s)
        if (!match) throw new Error('invalid image data')
        return {buffer: Buffer.from(match[2], 'base64'), contentType: match[1]}
    }
    const local = await persistImage(url)
    return {buffer: await fs.readFile(local.file), contentType: local.contentType}
}

http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type'});
        return res.end()
    }
    try {
        if (req.url === '/api/health' && req.method === 'GET') return send(res, 200, {ok: true, dataDir})
        if (req.url.startsWith('/api/generate/cancel') && req.method === 'POST') {
            const taskId = new URL(req.url, 'http://127.0.0.1').searchParams.get('taskId')
            const controller = taskId && activeGenerations.get(taskId)
            if (controller) controller.abort()
            return send(res, 200, {ok: true, cancelled: Boolean(controller)})
        }
        if (req.url === '/api/settings' && req.method === 'GET') {
            const settings = await read(files.settings, {apis: [], activeApiId: ''})
            const {adminPassword, ...safeSettings} = settings
            if (adminPassword !== undefined) await write(files.settings, safeSettings)
            return send(res, 200, safeSettings)
        }
        if (req.url === '/api/settings' && req.method === 'POST') {
            const {adminPassword, ...next} = await json(req)
            await write(files.settings, next);
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
        if (req.url === '/api/records' && req.method === 'GET') return send(res, 200, [])
        if (req.url.startsWith('/api/generated/') && req.method === 'GET') {
            const name = decodeURIComponent(req.url.slice('/api/generated/'.length)).replace(/[^a-zA-Z0-9._-]/g, '')
            if (!name || name.includes('..')) return send(res, 400, {error: 'invalid generated file'})
            try {
                const file = path.join(generatedDir, name)
                const buffer = await fs.readFile(file)
                const type = name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
                res.writeHead(200, {
                    'Content-Type': type,
                    'Cache-Control': 'public, max-age=31536000',
                    'Access-Control-Allow-Origin': '*'
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
                'Access-Control-Allow-Origin': '*'
            });
            return res.end(image.buffer)
        }
        if (req.url === '/api/save-image' && req.method === 'POST') {
            const {url, filename = 'atelier-image.png'} = await json(req)
            if (!url || typeof url !== 'string') return send(res, 400, {error: 'invalid image url'})
            const safeName = String(filename).replace(/[^a-zA-Z0-9._-]/g, '_')
            const image = await getDownloadImage(url)
            await fs.mkdir(exportDir, {recursive: true})
            const target = path.join(exportDir, safeName)
            await fs.writeFile(target, image.buffer)
            return send(res, 200, {ok: true, path: target, filename: safeName})
        }
        if (req.url === '/api/export' && req.method === 'POST') {
            const {urls = [], extension = 'png'} = await json(req)
            if (!urls.length) return send(res, 400, {error: '请选择图片'})
            const batch = exportStamp()
            await fs.mkdir(exportDir, {recursive: true})
            const saved = await Promise.all(urls.map(async (url, index) => {
                const image = await getDownloadImage(url)
                const filename = `phantom-tower-${batch}-${index + 1}.${extension}`.replace(/[^a-zA-Z0-9._-]/g, '_')
                const target = path.join(exportDir, filename)
                await fs.writeFile(target, image.buffer)
                return {filename, path: target}
            }))
            return send(res, 200, {ok: true, count: saved.length, files: saved})
        }
        if (req.url === '/api/models' && req.method === 'GET') {
            const api = await activeApi();
            if (!api) return send(res, 400, {error: '请先配置并启用 API'});
            const response = await fetch(apiUrl(api.endpoint, 'models'), {headers: {Authorization: `Bearer ${api.key}`}});
            const payload = await response.json()
            return send(res, response.status, response.ok ? filterReferenceImageModels(payload) : payload)
        }
        if (req.url === '/api/generate' && req.method === 'POST') {
            const input = await json(req);
            if (!supportsReferenceImages(input.model)) {
                return send(res, 400, {error: '该模型未通过参考图生成验证，不能在样片工厂中使用。请使用 gpt-image-2-1k。'})
            }
            const api = await activeApi();
            const mode = input.mode === 'image' ? 'image' : 'text'
            // UI task types describe the image role, while templates are keyed by
            // the user-facing operation. Normalize them before resolving presets.
            const operation = promptTemplateOperation(input.operation, mode)
            const builtIns = await read(files.builtInPromptTemplates, [])
            const builtIn = builtIns.find((item) => promptTemplateMatches(item, mode, operation))
            if (!builtIn) return send(res, 400, {error: '当前功能未配置内置提示词预设，请到提示词预设中完成配置'})
            const templates = await read(files.promptTemplates, [])
            const userTemplate = input.presetId ? templates.find((item) => item.id === input.presetId && promptTemplateMatches(item, mode, operation)) : null
            if (input.presetId && !userTemplate) return send(res, 400, {error: '所选提示词预设不存在，或不适用于当前功能'})
            const finalPrompt = [builtIn.systemPrompt, builtIn.defaultNegativePrompt && `负向提示词：${builtIn.defaultNegativePrompt}`, input.prompt, userTemplate?.systemPrompt, userTemplate?.defaultNegativePrompt && `负向提示词：${userTemplate.defaultNegativePrompt}`, input.extraPrompt]
                .filter((value) => typeof value === 'string' && value.trim()).join('\n\n')
            if (!api) return send(res, 400, {error: '请先配置并启用 API'})
            const controller = new AbortController();
            req.on('aborted', () => controller.abort())
            const images = []
            const responses = []
            for (let index = 0; index < Math.max(1, Number(input.n || 1)); index += 1) {
                if (controller.signal.aborted) break
                const payload = {
                    model: input.model,
                    prompt: finalPrompt,
                    n: 1,
                    quality: input.quality || 'medium',
                    response_format: 'url'
                }
                if (input.size && input.size !== 'auto') payload.size = input.size
                if (input.resolution) payload.resolution = input.resolution
                if (input.format) payload.output_format = input.format
                if (input.mask) payload.mask = input.mask
                const referenceImages = Array.isArray(input.images)
                    ? input.images.filter((image) => typeof image === 'string' && image.trim())
                    : []
                // This gateway accepts data-URL reference images in its JSON `images`
                // field. Multipart `images` requests are accepted but silently treated
                // as text-only generations, leaving image_tokens at zero.
                if (referenceImages.length) payload.images = referenceImages
                if (Array.isArray(input.materials) && input.materials.length) {
                    payload.materials = input.materials.map(({data, ...material}) => material)
                }
                const isLocalEdit = input.operation === 'local-edit'
                const imagePath = isLocalEdit ? '/images/edits' : '/images/generations'
                let body = JSON.stringify(payload)
                let headers = {'Content-Type': 'application/json', Authorization: `Bearer ${api.key}`}
                if (isLocalEdit) {
                    if (!referenceImages.length) return send(res, 400, {error: '局部编辑缺少基础图'})
                    // gpt-image-compatible edit APIs only ingest input images from
                    // multipart file fields. JSON data URLs are accepted by some
                    // gateways but treated as text, which produces image_tokens: 0.
                    const form = new FormData()
                    appendGenerationOptions(form, payload, input)
                    form.append('image', dataUrlFile(referenceImages[0]), 'reference.png')
                    form.append('input_fidelity', 'high')
                    body = form
                    headers = {Authorization: `Bearer ${api.key}`}
                }
                const activeTaskId = String(input.taskId || crypto.randomUUID())
                activeGenerations.set(activeTaskId, controller)
                let response
                try {
                    response = await fetch(apiUrl(api.endpoint, imagePath), {
                        method: 'POST',
                        headers,
                        body,
                        signal: controller.signal
                    })
                } finally {
                    activeGenerations.delete(activeTaskId)
                }
                const result = await response.json();
                if (!response.ok) return send(res, response.status, result)
                responses.push({
                    usage: result.usage || null,
                    revisedPrompts: (result.data || []).map((item) => item.revised_prompt).filter(Boolean)
                })
                images.push(...(result.data || []))
            }
            if (controller.signal.aborted) return
            const persistedImages = images.map((image) => {
                const source = image?.url || (image?.b64_json ? `data:image/png;base64,${image.b64_json}` : '')
                if (!source) return image
                // Cache each remote result once. Export and continue-edit reuse this task or the cached file.
                saveImageInBackground(source).catch((error) => console.error('image cache failed:', error.message))
                return {...image, url: source, sourceUrl: image.url}
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
                    builtinPresetId: builtIn.id,
                    imageCount: input.images?.length || 0,
                    materials: (input.materials || []).map((item, index) => ({
                        index: index + 1,
                        role: item.role || 'reference',
                        type: item.type
                    }))
                },
                responses,
                images: persistedImages.map((image) => ({...image, id: crypto.randomUUID(), taskId: input.taskId || null, parentResultId: input.parentResultId || null, version: Math.max(1, Number(input.version || 1))}))
            }
            // Generation history persistence is intentionally disabled. The generated
            // images and current response remain available, but no record is written
            // to data/generation-records.json.
            return send(res, 200, {created: Date.now(), data: persistedImages})
        }
        send(res, 404, {error: 'Not found'})
    } catch (error) {
        if (error.name !== 'AbortError') send(res, 500, {error: error.message})
    }
}).listen(4317, '127.0.0.1', () => console.log('PhantomTower local server: http://127.0.0.1:4317'))



