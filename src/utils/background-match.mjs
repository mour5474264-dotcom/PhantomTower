export function matchBackgrounds(targets, backgrounds) {
  const matches = new Map()
  if (!targets.length || !backgrounds.length) return matches
  if (backgrounds.length === 1) {
    for (const target of targets) matches.set(target, backgrounds[0])
    return matches
  }

  const score = (target, background) => {
    const targetRatio = target.width > 0 && target.height > 0 ? target.width / target.height : 1
    const backgroundRatio = background.width > 0 && background.height > 0 ? background.width / background.height : 1
    const orientation = Number(targetRatio >= 1 === backgroundRatio >= 1)
    const ratio = 1 - Math.min(1, Math.abs(Math.log(targetRatio / backgroundRatio)) / Math.log(2.5))
    let color = 0.5
    if (target.signature && background.signature) {
      const overlap = target.signature.bins.reduce((total, bin, index) => total + Math.min(bin, background.signature.bins[index]), 0)
      const luminance = 1 - Math.min(1, Math.abs(target.signature.luma - background.signature.luma) / 0.5)
      color = 0.5 * overlap + 0.5 * luminance
    }
    return 0.5 * orientation + 0.25 * ratio + 0.25 * color
  }

  const pairs = targets.flatMap((target) => backgrounds.map((background) => ({target, background, score: score(target, background)})))
  pairs.sort((a, b) => b.score - a.score)
  const usedBackgrounds = new Set()
  for (const pair of pairs) {
    if (matches.has(pair.target) || usedBackgrounds.has(pair.background)) continue
    matches.set(pair.target, pair.background)
    usedBackgrounds.add(pair.background)
  }
  for (const target of targets) {
    if (matches.has(target)) continue
    matches.set(target, backgrounds.reduce((best, candidate) => score(target, candidate) > score(target, best) ? candidate : best))
  }
  return matches
}

export async function createImageSignature(file) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null
  let bitmap
  try {
    bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'})
  } catch {
    return null
  }
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const context = canvas.getContext('2d', {willReadFrequently: true})
    if (!context) return null
    context.drawImage(bitmap, 0, 0, 16, 16)
    const {data} = context.getImageData(0, 0, 16, 16)
    const bins = new Float32Array(64)
    let luma = 0
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index]
      const green = data[index + 1]
      const blue = data[index + 2]
      bins[Math.min(3, red >> 6) * 16 + Math.min(3, green >> 6) * 4 + Math.min(3, blue >> 6)] += 1
      luma += 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    for (let index = 0; index < bins.length; index += 1) bins[index] /= 256
    return {bins, luma: luma / 256 / 255}
  } finally {
    bitmap.close?.()
  }
}
