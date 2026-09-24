const imageTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff'
}

export const GENERATED_IMAGE_DRAG_TYPE = 'application/x-phantom-tower-generated-image'
const GENERATED_IMAGE_TEXT_PREFIX = 'phantom-tower-generated-image:'

export function normalizeImageFile(file) {
  if (!file || file.isDirectory) return null
  if (file.type?.toLowerCase().startsWith('image/')) return file
  if (file.type && file.type !== 'application/octet-stream') return null
  const type = imageTypes[file.name?.split('.').pop()?.toLowerCase()]
  if (!type) return null
  return new File([file], file.name, {type, lastModified: file.lastModified})
}

export function droppedFiles(transfer) {
  // Read synchronously: Chromium clears the drag data after the drop event.
  const files = Array.from(transfer?.files || [])
  if (files.length) return files
  return Array.from(transfer?.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile?.())
    .filter(Boolean)
}

// Safari may discard custom data types during a drag, so keep the URL in a
// namespaced text fallback as well. Plain URLs are deliberately ignored.
export function setGeneratedImageDrag(transfer, url) {
  if (!transfer || !url) return
  transfer.effectAllowed = 'copy'
  transfer.setData(GENERATED_IMAGE_DRAG_TYPE, url)
  transfer.setData('text/plain', `${GENERATED_IMAGE_TEXT_PREFIX}${url}`)
}

export function droppedGeneratedImageUrl(transfer) {
  if (!transfer) return ''
  const customUrl = transfer.getData?.(GENERATED_IMAGE_DRAG_TYPE)
  const fallback = transfer.getData?.('text/plain') || ''
  const url = customUrl || (fallback.startsWith(GENERATED_IMAGE_TEXT_PREFIX)
    ? fallback.slice(GENERATED_IMAGE_TEXT_PREFIX.length)
    : '')
  return /^(?:data:image\/|https?:\/\/)/i.test(url) ? url : ''
}
