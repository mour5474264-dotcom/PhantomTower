const BASE = 'http://127.0.0.1:4317'

export function imageThumbnailUrl(source) {
  if (!/^https?:\/\//i.test(source || '')) return source || ''
  return `${BASE}/api/download?thumbnail=1&url=${encodeURIComponent(source)}`
}

export function resultImageSource(item) {
  return item?.exportUrl || item?.localUrl || item?.url || ''
}
