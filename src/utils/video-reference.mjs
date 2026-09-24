export function videoSampleTimes(duration, count = 8) {
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长')
  if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error('参考帧数量应为 1 到 24')
  return Array.from({length: count}, (_, index) => duration * (index + 0.5) / count)
}

function frameQuality(context, width, height) {
  // Analyse a small copy only. Detail (Laplacian variance) rejects motion blur;
  // the exposure penalty avoids frames that lose facial detail in shadows/highlights.
  const analysisWidth = 192
  const analysisHeight = Math.max(1, Math.round(height / width * analysisWidth))
  const analysis = document.createElement('canvas')
  analysis.width = analysisWidth
  analysis.height = analysisHeight
  const analysisContext = analysis.getContext('2d', {willReadFrequently: true})
  if (!analysisContext) return 0
  analysisContext.drawImage(context.canvas, 0, 0, analysisWidth, analysisHeight)
  const {data} = analysisContext.getImageData(0, 0, analysisWidth, analysisHeight)
  const luminance = new Float32Array(analysisWidth * analysisHeight)
  let sum = 0
  let clipped = 0
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4
    const value = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
    luminance[index] = value
    sum += value
    if (value < 18 || value > 242) clipped += 1
  }
  let laplacianSum = 0
  let laplacianSquaredSum = 0
  let samples = 0
  for (let y = 1; y < analysisHeight - 1; y += 1) {
    for (let x = 1; x < analysisWidth - 1; x += 1) {
      const index = y * analysisWidth + x
      const laplacian = 4 * luminance[index] - luminance[index - 1] - luminance[index + 1] - luminance[index - analysisWidth] - luminance[index + analysisWidth]
      laplacianSum += laplacian
      laplacianSquaredSum += laplacian * laplacian
      samples += 1
    }
  }
  const detail = Math.max(0, laplacianSquaredSum / samples - (laplacianSum / samples) ** 2)
  const mean = sum / luminance.length
  const exposure = Math.max(0, 1 - Math.abs(mean - 128) / 128) * Math.max(0, 1 - clipped / luminance.length * 1.5)
  return Math.sqrt(detail) * (0.55 + exposure * 0.45)
}

async function faceScore(context, width, height, detector) {
  if (!detector) return 0
  try {
    const faces = await detector.detect(context.canvas)
    return Math.max(0, ...faces.map((face) => {
      const box = face.boundingBox
      return Math.max(0, box.width * box.height / (width * height))
    }))
  } catch {
    // A malformed frame must not prevent the remaining video from being read.
    return 0
  }
}

function selectReferenceFrames(candidates, count, duration) {
  if (candidates.length <= count) return candidates
  const maxQuality = Math.max(...candidates.map((candidate) => candidate.quality), 1)
  const maxFaceScore = Math.max(...candidates.map((candidate) => candidate.faceScore), 1e-6)
  const identityScore = (candidate) => candidate.faceScore / maxFaceScore * 0.72 + candidate.quality / maxQuality * 0.28
  // A face is mandatory for the first reference. It is the strongest identity
  // anchor and avoids a sharp back-view or background taking first position.
  const faceCandidates = candidates.filter((candidate) => candidate.faceScore > 0)
  const selected = [(faceCandidates.length ? faceCandidates : candidates).reduce((best, candidate) => identityScore(candidate) > identityScore(best) ? candidate : best)]
  while (selected.length < count) {
    const next = candidates.filter((candidate) => !selected.includes(candidate)).reduce((best, candidate) => {
      const nearest = Math.min(...selected.map((item) => Math.abs(item.time - candidate.time))) / duration
      const score = identityScore(candidate) + nearest * 0.22
      return !best || score > best.score ? {candidate, score} : best
    }, null)
    selected.push(next.candidate)
  }
  // Image models generally weight earlier references more strongly.
  return selected.sort((left, right) => identityScore(right) - identityScore(left))
}

function waitForVideo(video, event, signal, action) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer)
      video.removeEventListener(event, ready)
      video.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
      error ? reject(error) : resolve()
    }
    const ready = () => finish()
    const failed = () => finish(new Error('无法解码视频，请转换为 H.264 编码的 MP4 后重试'))
    const aborted = () => finish(new DOMException('已取消', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('视频读取超时，请换用较短的视频')), 30000)
    video.addEventListener(event, ready, {once: true})
    video.addEventListener('error', failed, {once: true})
    signal?.addEventListener('abort', aborted, {once: true})
    if (signal?.aborted) return aborted()
    try { action() } catch (error) { finish(error) }
  })
}

export async function extractVideoReferences(file, {count = 8, signal, onProgress = () => {}} = {}) {
  if (!file || (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v)$/i.test(file.name))) {
    throw new Error('请选择 MP4、MOV 或 WebM 视频')
  }
  if (!file.size || file.size > 500 * 1024 * 1024) throw new Error('视频不能为空，且不能超过 500 MB')
  const video = document.createElement('video')
  const source = URL.createObjectURL(file)
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  try {
    await waitForVideo(video, 'loadedmetadata', signal, () => { video.src = source; video.load() })
    if (!video.videoWidth || !video.videoHeight) throw new Error('视频没有可读取的画面')
    const outputCount = Math.min(count, 8)
    const candidateCount = Math.min(24, Math.max(12, outputCount * 3))
    const times = videoSampleTimes(video.duration, candidateCount)
    const scale = Math.min(1, 1536 / Math.max(video.videoWidth, video.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建视频画面')
    const detector = typeof globalThis.FaceDetector === 'function'
      ? new globalThis.FaceDetector({fastMode: true, maxDetectedFaces: 3})
      : null
    const candidates = []
    for (const time of times) {
      await waitForVideo(video, 'seeked', signal, () => { video.currentTime = time })
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      signal?.throwIfAborted()
      candidates.push({
        time,
        quality: frameQuality(context, canvas.width, canvas.height),
        faceScore: await faceScore(context, canvas.width, canvas.height, detector)
      })
      onProgress(candidates.length, times.length)
    }
    if (detector && !candidates.some((candidate) => candidate.faceScore > 0)) {
      throw new Error('视频中没有检测到清晰人脸，无法可靠生成相似的三视图。请上传包含正脸、无遮挡、光线充足画面的视频，或改用人物参考图。')
    }
    const frames = []
    for (const [index, candidate] of selectReferenceFrames(candidates, outputCount, video.duration).entries()) {
      await waitForVideo(video, 'seeked', signal, () => { video.currentTime = candidate.time })
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95))
      signal?.throwIfAborted()
      if (!blob) throw new Error('视频画面提取失败')
      frames.push({file: new File([blob], `${file.name}-reference-${String(index + 1).padStart(2, '0')}-${candidate.time.toFixed(2)}s.jpg`, {type: 'image/jpeg'}), width: canvas.width, height: canvas.height, quality: candidate.quality, faceScore: candidate.faceScore})
    }
    return frames
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(source)
  }
}
