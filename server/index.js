import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZipArchive } from 'archiver'

const dataDir = process.env.PHANTOMTOWER_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '../data')
const files = { settings: path.join(dataDir, 'settings.json'), records: path.join(dataDir, 'generation-records.json'), presets: path.join(dataDir, 'presets.json') }
async function read(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback } }
async function write(file, data) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8') }
function send(res, status, data) { if (res.destroyed) return; res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)) }
async function json(req) { let value = ''; for await (const chunk of req) value += chunk; return value ? JSON.parse(value) : {} }
function base(url) { return url.replace(/\/(chat\/completions|images\/generations|models)\/?$/i, '').replace(/\/$/, '') }
async function activeApi() { const settings = await read(files.settings, { apis: [], activeApiId: '' }); return settings.apis.find((item) => item.id === settings.activeApiId) }

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end() }
  try {
    if (req.url === '/api/settings' && req.method === 'GET') return send(res, 200, await read(files.settings, { apis: [], activeApiId: '' }))
    if (req.url === '/api/settings' && req.method === 'POST') { await write(files.settings, await json(req)); return send(res, 200, { ok: true }) }
    if (req.url === '/api/presets' && req.method === 'GET') return send(res, 200, await read(files.presets, []))
    if (req.url === '/api/presets' && req.method === 'POST') { await write(files.presets, await json(req)); return send(res, 200, { ok: true }) }
    if (req.url === '/api/records' && req.method === 'GET') return send(res, 200, await read(files.records, []))
    if (req.url.startsWith('/api/download') && req.method === 'GET') { const target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url'); if (!target || !/^https?:/.test(target)) return send(res, 400, { error: 'invalid url' }); const response = await fetch(target); const buffer = Buffer.from(await response.arrayBuffer()); res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Content-Disposition': 'attachment; filename="atelier-image.png"', 'Access-Control-Allow-Origin': 'http://localhost:5173' }); return res.end(buffer) }
    if (req.url === '/api/export' && req.method === 'POST') { const { urls = [] } = await json(req); if (!urls.length) return send(res, 400, { error: '请选择图片' }); res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="atelier-images.zip"', 'Access-Control-Allow-Origin': 'http://localhost:5173' }); const archive = new ZipArchive({ zlib: { level: 6 } }); archive.pipe(res); const buffers = await Promise.all(urls.map(async (url) => Buffer.from(await (await fetch(url)).arrayBuffer()))); buffers.forEach((buffer, index) => archive.append(buffer, { name: `atelier-${index + 1}.png` })); await archive.finalize(); return }
    if (req.url === '/api/models' && req.method === 'GET') { const api = await activeApi(); if (!api) return send(res, 400, { error: '请先配置并启用 API' }); const response = await fetch(`${base(api.endpoint)}/models`, { headers: { Authorization: `Bearer ${api.key}` } }); return send(res, response.status, await response.json()) }
    if (req.url.startsWith('/api/balance') && req.method === 'GET') { const settings = await read(files.settings, { apis: [], activeApiId: '' }); const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('apiId'); const api = (settings.apis || []).find((item) => item.id === id) || (settings.apis || []).find((item) => item.id === settings.activeApiId); if (!api) return send(res, 400, { error: '请先配置 API' }); const root = base(api.endpoint); const paths = ['/dashboard/billing/subscription', '/v1/dashboard/billing/subscription', '/dashboard/billing/usage']; let last = null; for (const route of paths) { const response = await fetch(`${root}${route}`, { headers: { Authorization: `Bearer ${api.key}` } }); const data = await response.json(); if (response.ok) return send(res, 200, data); last = data } return send(res, 404, { error: last?.error?.message || '中转站未提供余额接口' }) }
    if (req.url === '/api/generate' && req.method === 'POST') {
      const input = await json(req); const api = await activeApi(); if (!api) return send(res, 400, { error: '请先配置并启用 API' })
      const controller = new AbortController(); req.on('close', () => controller.abort())
      const images = []
      for (let index = 0; index < Math.max(1, Number(input.n || 1)); index += 1) {
        if (controller.signal.aborted) break
        const payload = { model: input.model, prompt: input.prompt, n: 1, quality: input.quality || 'medium' }
        if (Array.isArray(input.images) && input.images.length) payload.images = input.images
        if (Array.isArray(input.materials) && input.materials.length) payload.materials = input.materials
        if (input.size && input.size !== 'auto') payload.size = input.size
        const response = await fetch(`${base(api.endpoint)}/images/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.key}` }, body: JSON.stringify(payload), signal: controller.signal })
        const result = await response.json(); if (!response.ok) return send(res, response.status, result); images.push(...(result.data || []))
      }
      if (controller.signal.aborted) return
      const record = { id: Date.now().toString(), createdAt: new Date().toISOString(), model: input.model, prompt: input.prompt, images }
      const records = await read(files.records, []); records.unshift(record); await write(files.records, records)
      return send(res, 200, { created: Date.now(), data: images })
    }
    send(res, 404, { error: 'Not found' })
  } catch (error) { if (error.name !== 'AbortError') send(res, 500, { error: error.message }) }
}).listen(4317, '127.0.0.1', () => console.log('PhantomTower local server: http://127.0.0.1:4317'))
