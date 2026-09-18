const imageTypes = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff'
}

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
