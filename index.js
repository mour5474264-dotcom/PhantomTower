import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'

const dataDir = process.env.PHANTOMTOWER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data')
const generatedDir = path.join(dataDir, 'generated')
const exportDir = process.env.PHANTOMTOWER_EXPORT_DIR || path.join(dataDir, 'export')
const files = {
    settings: path.join(dataDir, 'settings.json'),
    records: path.join(dataDir, 'generation-records.json'),
    presets: path.join(dataDir, 'presets.json'),
    builtInPresets: path.join(dataDir, 'builtin-presets.json'),
    imageCache: path.join(dataDir, 'image-cache.json')
}
const pendingImages = new Map()
let recordsWriteQueue = Promise.resolve()

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
    try {
        for (let attempt = 0; attempt < 16; attempt += 1) {
            try {
                await fs.rename(temporary, file)
                return
            } catch (error) {
                const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
                if (!retryable || attempt === 15) throw error
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, 50 * (attempt + 1))))
            }
        }
    } catch (error) {
        await fs.rm(temporary, {force: true}).catch(() => null)
        throw error
    }
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

function base(url) {
    return url.replace(/\/(chat\/completions|images\/generations|models)\/?$/i, '').replace(/\/$/, '')
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

async function resolveRecordImage(image) {
    const currentUrl = String(image?.url || '')
    if (currentUrl.startsWith('http://127.0.0.1:4317/api/generated/')) {
        try {
            const filename = decodeURIComponent(new URL(currentUrl).pathname.slice('/api/generated/'.length))
            await fs.access(path.join(generatedDir, filename))
            return image
        } catch {
            // Fall through to the durable provider URL or embedded image data.
        }
    } else if (currentUrl || image?.b64_json) {
        return image
    }
    if (typeof image?.sourceUrl === 'string' && /^https?:\/\//i.test(image.sourceUrl)) {
        return {...image, url: image.sourceUrl}
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
                await new Promise((resolve) => setTimeout(resolve, Math.min(250, 50 * (attempt + 1))))
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
    const response = await fetch(url)
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

async function externalizeRecordImage(image) {
    const value = {...(image || {})}
    const inlineData = typeof value.b64_json === 'string' && value.b64_json
    if (!inlineData) return value
    if (!value.url || /^data:image\//i.test(value.url)) {
        const contentType = value.mime_type || value.content_type || 'image/png'
        const persisted = await persistImage(`data:${contentType};base64,${inlineData}`)
        value.url = generatedUrl(persisted.filename)
    }
    if (/^data:image\//i.test(String(value.sourceUrl || ''))) delete value.sourceUrl
    delete value.b64_json
    return value
}

function appendGenerationRecord(record) {
    recordsWriteQueue = recordsWriteQueue.catch(() => null).then(async () => {
        const records = await read(files.records, [])
        records.unshift(record)
        await write(files.records, records.slice(0, 500))
    })
    return recordsWriteQueue
}

async function getDownloadImage(url) {
    if (/^data:image\//i.test(url)) {
        const match = url.match(/^data:([^;]+);base64,(.+)$/s)
        if (!match) throw new Error('invalid image data')
        return {buffer: Buffer.from(match[2], 'base64'), contentType: match[1]}
    }
    // Reuse a locally cached generation before falling back to the network.
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

http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'});
        return res.end()
    }
    try {
        if (req.url === '/api/health' && req.method === 'GET') return send(res, 200, {ok: true, dataDir, exportDir})
        if (req.url === '/api/settings' && req.method === 'GET') return send(res, 200, await read(files.settings, {
            apis: [],
            activeApiId: ''
        }))
        if (req.url === '/api/settings' && req.method === 'POST') {
            await write(files.settings, await json(req));
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
        if (req.url === '/api/records' && req.method === 'GET') {
            const records = await read(files.records, [])
            return send(res, 200, await resolveRecordImages(Array.isArray(records) ? records : []))
        }
        if (req.url.startsWith('/api/image-status') && req.method === 'GET') {
            const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url')
            return send(res, 200, {saving: Boolean(target && pendingImages.has(target))})
        }
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
            const response = await fetch(`${base(api.endpoint)}/models`, {headers: {Authorization: `Bearer ${api.key}`}});
            return send(res, response.status, await response.json())
        }
        if (req.url.startsWith('/api/balance') && req.method === 'GET') {
            const settings = await read(files.settings, {apis: [], activeApiId: ''});
            const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('apiId');
            const api = (settings.apis || []).find((item) => item.id === id) || (settings.apis || []).find((item) => item.id === settings.activeApiId);
            if (!api) return send(res, 400, {error: '请先配置 API'});
            const root = base(api.endpoint);
            const paths = ['/dashboard/billing/subscription', '/v1/dashboard/billing/subscription', '/dashboard/billing/usage'];
            let last = null;
            for (const route of paths) {
                const response = await fetch(`${root}${route}`, {headers: {Authorization: `Bearer ${api.key}`}});
                const data = await response.json();
                if (response.ok) return send(res, 200, data);
                last = data
            }
            return send(res, 404, {error: last?.error?.message || '中转站未提供余额接口'})
        }
        if (req.url === '/api/generate' && req.method === 'POST') {
            const input = await json(req);
            const api = await activeApi();
            if (!api) return send(res, 400, {error: '请先配置并启用 API'})
            const controller = new AbortController();
            req.on('close', () => controller.abort())
            const images = []
            const responses = []
            for (let index = 0; index < Math.max(1, Number(input.n || 1)); index += 1) {
                if (controller.signal.aborted) break
                const payload = {
                    model: input.model,
                    prompt: input.prompt,
                    n: 1,
                    quality: 'high',
                    response_format: 'url'
                }
                if (input.size && input.size !== 'auto') payload.size = input.size
                const referenceImages = Array.isArray(input.images)
                    ? input.images.filter((image) => typeof image === 'string' && image.trim())
                    : []
                // Image2 accepts `image` as a single data URI/URL or an array of them.
                if (referenceImages.length) payload.image = referenceImages.length === 1
                    ? referenceImages[0]
                    : referenceImages
                const response = await fetch(`${base(api.endpoint)}/images/generations`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${api.key}`},
                    body: JSON.stringify(payload),
                    signal: controller.signal
                })
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
                saveImageInBackground(source).catch((error) => console.error('image cache failed:', error.message))
                return {...image, url: source, sourceUrl: image.url, saving: true}
            })
            const recordImages = await Promise.all(persistedImages.map(async (image) => ({
                ...(await externalizeRecordImage(image)),
                id: crypto.randomUUID()
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
                prompt: input.prompt,
                request: {
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
            return send(res, 200, {created: Date.now(), data: responseImages})
        }
        send(res, 404, {error: 'Not found'})
    } catch (error) {
        if (error.name !== 'AbortError') send(res, 500, {error: error.message})
    }
}).listen(4317, '127.0.0.1', () => console.log('PhantomTower local server: http://127.0.0.1:4317'))
