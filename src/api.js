const BASE = 'http://127.0.0.1:4317'

// Providers occasionally return an image URL wrapped as a Markdown link,
// e.g. `[https://example.com/image.png](https://example.com/image.png)`.
// Browser image elements need the destination URL itself.
export function normalizeImageUrl(value) {
    let url = String(value || '').trim()
    if (!url) return ''
    const markdown = url.match(/^!?(?:\[[^\]]*\])\(\s*<?([^>\s]+)>?\s*\)$/i)
    if (markdown?.[1]) url = markdown[1]
    return url.replace(/^<|>$/g, '').replace(/^['"]|['"]$/g, '').trim()
}

export function formatApiError(error, fallback = '操作失败') {
    if (!error) return fallback
    const details = error.details && typeof error.details === 'object' ? error.details : {}
    const message = String(error.message || fallback)
    const lines = [message]
    const add = (label, value) => {
        if (value === undefined || value === null || value === '') return
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
        if (!lines.some((line) => line.includes(text))) lines.push(`${label}：${text}`)
    }
    add('错误码', details.code || error.code)
    add('HTTP', details.status || error.status)
    add('请求路径', details.path)
    add('服务端状态', details.health === 'online' ? '在线' : details.health)
    add('原始 fetch 名称', details.originalName)
    add('原始 fetch 错误码', details.originalCode)
    add('原始 fetch 消息', details.originalMessage)
    add('原始上游错误', details.original)
    add('上游服务商', details.provider)
    add('上游地址', details.endpoint)
    add('服务端建议', details.hint)
    add('上游原始响应', typeof details.upstream === 'string' ? details.upstream : details.bodyPreview)
    return lines.join('\n')
}

function errorDetail(error) {
    const code = error?.cause?.code || error?.code || ''
    const message = error?.cause?.message || error?.message || String(error || '')
    return [code && `代码 ${code}`, message].filter(Boolean).join('：') || '未知网络错误'
}

async function transportError(path, original) {
    let health = 'unknown'
    try {
        const response = await fetch(`${BASE}/api/health`, {cache: 'no-store'})
        health = response.ok ? 'online' : `http-${response.status}`
    } catch {}
    const prefix = health === 'online'
        ? '本地数据服务在线，但请求未完成'
        : '无法连接本地数据服务'
    const error = new Error(`${prefix}（${path}）：${errorDetail(original)}`)
    error.code = 'LOCAL_SERVICE_TRANSPORT_ERROR'
    error.cause = original
    error.details = {
        path,
        base: BASE,
        health,
        originalName: original?.name || '',
        originalCode: original?.cause?.code || original?.code || '',
        originalMessage: original?.cause?.message || original?.message || String(original || '')
    }
    return error
}

async function request(path, options, fallback) {
    let response
    try {
        response = await fetch(`${BASE}${path}`, options)
    } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw await transportError(path, error)
    }
    const raw = await response.text()
    let data = {}
    try {
        data = raw ? JSON.parse(raw) : {}
    } catch (parseError) {
        const error = new Error(`${fallback}（HTTP ${response.status}）：本地服务返回了无效 JSON：${raw.slice(0, 300) || parseError.message}`)
        error.status = response.status
        error.code = 'LOCAL_SERVICE_INVALID_RESPONSE'
        error.details = {path, status: response.status, bodyPreview: raw.slice(0, 300)}
        throw error
    }
    if (!response.ok) {
        const error = new Error(data.error?.message || data.error || fallback)
        error.status = response.status
        error.details = {...data, path, status: response.status}
        throw error
    }
    return data
}

export async function getSettings() {
    return request('/api/settings', undefined, 'API 配置读取失败')
}

export async function saveSettings(settings) {
    await request('/api/settings', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(settings)
    }, 'API 配置保存失败')
}

export async function clearGeneratedCache() {
    return request('/api/cache/clear', {method: 'POST'}, '缓存清理失败')
}

export function notifyActiveApiChanged(activeApiId = '') {
    localStorage.setItem('atelier-active-api', activeApiId)
    window.dispatchEvent(new CustomEvent('sample-factory-active-api-changed', {detail: {activeApiId}}))
}

export function notifyPromptTemplatesChanged() {
    window.dispatchEvent(new Event('sample-factory-prompt-templates-changed'))
}

export async function getModels() {
    const data = await request('/api/models', undefined, '模型读取失败');
    return data.data || data.models || []
}

export async function testApiConnection(api) {
    const data = await request('/api/models/test', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(api)
    }, '连接测试失败')
    return {models: data.data || data.models || [], detection: data.detection || null}
}

export async function generateImage(input, options = {}) {
    return request('/api/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(input),
        signal: options.signal
    }, '图片生成失败')
}

export async function getVisionStatus() {
    return request('/api/vision/status', {cache: 'no-store'}, '本地视觉服务状态读取失败')
}

export async function generatePersonMask(image, options = {}) {
    return request('/api/vision/mask', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({image, ...options})
    }, '人物 mask 生成失败')
}

export async function cancelGeneration(taskId) {
    if (!taskId) return {ok: false, cancelled: false}
    return request(`/api/generate/cancel?taskId=${encodeURIComponent(taskId)}`, {method: 'POST'}, 'generation cancellation failed')
}

export async function getPresets() {
    return request('/api/presets', undefined, '提示词预设读取失败')
}

export async function savePresets(value) {
    await request('/api/presets', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(value)
    }, '提示词预设保存失败')
}

export async function getPromptTemplates() {
    return request('/api/prompt-templates', {cache: 'no-store'}, '提示词模板读取失败')
}

export async function savePromptTemplates(value) {
    return request('/api/prompt-templates', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(value)
    }, '提示词模板保存失败')
}

export async function restoreDefaultPromptTemplates() {
    return request('/api/prompt-templates/restore-defaults', {method: 'POST'}, '恢复默认模板失败')
}

export const getBuiltInPromptTemplates = () => request('/api/builtin-prompt-templates', undefined, '内置提示词预设读取失败')
export const saveBuiltInPromptTemplates = (value) => request('/api/builtin-prompt-templates', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)}, '内置提示词预设保存失败')
export const restoreDefaultBuiltInPromptTemplates = () => request('/api/builtin-prompt-templates/restore-defaults', {method: 'POST'}, '恢复内置提示词预设失败')

export async function getPromptTemplateHistory(templateId) {
    return request(`/api/prompt-templates/history?templateId=${encodeURIComponent(templateId)}`, undefined, '提示词模板历史读取失败')
}

export async function getRecords() {
    return request('/api/records', undefined, '生成记录读取失败')
}

export async function deleteRecord(id) {
    return request(`/api/records/${encodeURIComponent(id)}`, {method: 'DELETE'}, '生成记录删除失败')
}

export async function deleteAllRecords() {
    return request('/api/records', {method: 'DELETE'}, '生成记录删除失败')
}

function shortId() {
    return (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 8)
}

function stamp() {
    const date = new Date()
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function makeImageFilename(index = 1, extension = 'png') {
    return `phantom-tower-${stamp()}-${shortId()}-${index}.${extension}`
}

export function downloadUrl(url, filename = 'atelier-image.png') {
    if (/^data:/i.test(url) || url.startsWith(`${BASE}/api/generated/`)) return url
    return `${BASE}/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`
}

export async function prepareEditImage(url) {
    return request('/api/prepare-edit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url})
    }, '编辑基础图准备失败')
}

export async function downloadImage(url, filename = 'atelier-image.png') {
    const response = await fetch(`${BASE}/api/save-image`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url, filename})})
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || 'image save failed')
    return data
}

export async function exportImages(urls, extension = 'png') {
    return request('/api/export', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({urls, extension})
    }, '图片导出失败')
}

