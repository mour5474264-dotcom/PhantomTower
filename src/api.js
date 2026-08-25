const BASE = 'http://127.0.0.1:4317'

async function request(path, options, fallback) {
    let response
    try {
        response = await fetch(`${BASE}${path}`, options)
    } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error('本地数据服务未连接，请关闭程序后重新打开')
    }
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error?.message || data.error || fallback)
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

export function notifyActiveApiChanged(activeApiId = '') {
    localStorage.setItem('atelier-active-api', activeApiId)
    window.dispatchEvent(new CustomEvent('sample-factory-active-api-changed', {detail: {activeApiId}}))
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
    return data.data || data.models || []
}

export async function generateImage(input, options = {}) {
    return request('/api/generate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(input),
        signal: options.signal
    }, '图片生成失败')
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

