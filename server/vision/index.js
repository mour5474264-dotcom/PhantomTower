import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const MODEL_FILES = {
    detector: ['person-detector.onnx', 'yolov8n.onnx'],
    encoder: ['sam2-encoder.onnx', 'image_encoder.onnx'],
    decoder: ['sam2-decoder.onnx', 'image_decoder.onnx', 'decoder.onnx']
}

let runtime
let sessions
let sharpRuntime

function loadPackage(name) {
    const candidates = [name]
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar', 'node_modules', name))
        candidates.push(path.join(process.resourcesPath, 'app', 'node_modules', name))
    }
    let lastError
    for (const candidate of candidates) {
        try { return require(candidate) } catch (error) { lastError = error }
    }
    throw lastError || new Error(`无法加载 ${name}`)
}

function modelDir() {
    return process.env.PHANTOMTOWER_VISION_MODELS_DIR
        || path.join(process.cwd(), 'vision-models')
}

async function modelState() {
    const directory = modelDir()
    const resolved = {}
    for (const [key, names] of Object.entries(MODEL_FILES)) {
        resolved[key] = null
        for (const name of names) {
            if (await fs.access(path.join(directory, name)).then(() => true).catch(() => false)) {
                resolved[key] = name
                break
            }
        }
    }
    const files = Object.fromEntries(Object.entries(resolved).map(([key, file]) => [key, Boolean(file)]))
    return {directory, files, modelFiles: resolved, ready: Object.values(files).every(Boolean)}
}

async function loadRuntime(state) {
    if (!state.ready) return null
    if (sessions) return sessions
    try {
        runtime = loadPackage('onnxruntime-node')
        const options = {executionProviders: ['dml', 'cpu']}
        sessions = {
            detector: await runtime.InferenceSession.create(path.join(state.directory, resolveModelName(state, 'detector')), options),
            encoder: await runtime.InferenceSession.create(path.join(state.directory, resolveModelName(state, 'encoder')), options),
            decoder: await runtime.InferenceSession.create(path.join(state.directory, resolveModelName(state, 'decoder')), options)
        }
        return sessions
    } catch (error) {
        sessions = null
        runtime = null
        const wrapped = new Error(`视觉模型加载失败：${error.message}`)
        wrapped.code = 'VISION_MODEL_LOAD_FAILED'
        throw wrapped
    }
}

function resolveModelName(state, key) {
    const names = MODEL_FILES[key] || []
    // Prefer the first existing alias. modelState has already verified it.
    return state.modelFiles?.[key] || names[0]
}

function parseDataUrl(value) {
    const match = String(value || '').match(/^data:([^;]+);base64,(.+)$/s)
    if (!match) throw Object.assign(new Error('图片必须是 base64 data URL'), {code: 'INVALID_IMAGE_DATA'})
    return {mimeType: match[1], buffer: Buffer.from(match[2], 'base64')}
}

function dataUrl(buffer, mimeType = 'image/png') {
    return `data:${mimeType};base64,${buffer.toString('base64')}`
}

async function imageInfo(image) {
    const parsed = parseDataUrl(image)
    sharpRuntime ||= loadPackage('sharp')
    const metadata = await sharpRuntime(parsed.buffer).metadata()
    if (!metadata.width || !metadata.height) throw Object.assign(new Error('无法读取目标图尺寸'), {code: 'INVALID_IMAGE'})
    return {...parsed, width: metadata.width, height: metadata.height}
}

function tensor(runtime, type, data, dims) {
    return new runtime.Tensor(type, data, dims)
}

function sessionInputs(session) {
    if (Array.isArray(session?.inputs)) return session.inputs
    return (session?.inputNames || []).map((name) => ({
        name,
        shape: session.inputMetadata?.[name]?.dimensions || session.inputMetadata?.[name]?.shape || []
    }))
}

function sessionOutputs(session) {
    if (Array.isArray(session?.outputs)) return session.outputs
    return (session?.outputNames || []).map((name) => ({name}))
}

function modelInputShape(session, fallback = [1, 3, 1024, 1024]) {
    const shape = sessionInputs(session)[0]?.shape
    return Array.isArray(shape) && shape.length === 4
        ? shape.map((value, index) => Number.isInteger(value) ? value : fallback[index])
        : fallback
}

async function imageTensor(runtime, buffer, session, {normalize = true} = {}) {
    sharpRuntime ||= loadPackage('sharp')
    const {info} = await sharpRuntime(buffer).removeAlpha().raw().toBuffer({resolveWithObject: true})
    const shape = modelInputShape(session, [1, 3, 1024, 1024])
    const height = shape[2]
    const width = shape[3]
    const resized = await sharpRuntime(buffer).removeAlpha().resize(width, height, {fit: 'fill'}).raw().toBuffer()
    const plane = width * height
    const values = new Float32Array(plane * 3)
    const mean = normalize ? [0.485, 0.456, 0.406] : [0, 0, 0]
    const std = normalize ? [0.229, 0.224, 0.225] : [1, 1, 1]
    for (let i = 0; i < plane; i += 1) {
        values[i] = (resized[i * 3] / 255 - mean[0]) / std[0]
        values[plane + i] = (resized[i * 3 + 1] / 255 - mean[1]) / std[1]
        values[plane * 2 + i] = (resized[i * 3 + 2] / 255 - mean[2]) / std[2]
    }
    return {tensor: tensor(runtime, 'float32', values, [1, 3, height, width]), width: info.width, height: info.height}
}

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value))
}

function probability(value) {
    // Ultralytics ONNX exports contain probabilities; some older exports keep logits.
    return value >= 0 && value <= 1 ? value : sigmoid(value)
}

function iou(a, b) {
    const left = Math.max(a.x1, b.x1)
    const top = Math.max(a.y1, b.y1)
    const right = Math.min(a.x2, b.x2)
    const bottom = Math.min(a.y2, b.y2)
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
    const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1)
    const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
    return intersection / Math.max(1, areaA + areaB - intersection)
}

function detectPeople(runtime, session, output, width, height) {
    const values = output?.data || output
    const dims = output?.dims || []
    if (!values || !dims.length) return []
    const rows = dims[dims.length - 1] === 84 || dims[dims.length - 1] === 85 ? dims[dims.length - 1] : dims[dims.length - 2]
    const count = dims[dims.length - 1] === rows ? dims[dims.length - 2] : dims[dims.length - 1]
    const transposed = dims[dims.length - 1] === rows
    const get = (row, column) => Number(values[transposed ? row * rows + column : column * count + row])
    const candidates = []
    for (let row = 0; row < count; row += 1) {
        const cx = get(row, 0)
        const cy = get(row, 1)
        const w = get(row, 2)
        const h = get(row, 3)
        if (![cx, cy, w, h].every(Number.isFinite)) continue
        let score = 0
        let classIndex = 0
        const classStart = rows >= 85 ? 5 : 4
        for (let column = classStart; column < rows; column += 1) {
            const value = get(row, column)
            if (value > score) { score = value; classIndex = column - classStart }
        }
        score = probability(score) * (rows >= 85 ? probability(get(row, 4)) : 1)
        if (classIndex !== 0 || score < 0.35) continue
        const scaleX = width / Number(modelInputShape(session)[3])
        const scaleY = height / Number(modelInputShape(session)[2])
        candidates.push({x1: Math.max(0, (cx - w / 2) * scaleX), y1: Math.max(0, (cy - h / 2) * scaleY), x2: Math.min(width, (cx + w / 2) * scaleX), y2: Math.min(height, (cy + h / 2) * scaleY), score})
    }
    candidates.sort((a, b) => b.score - a.score)
    const kept = []
    for (const candidate of candidates) {
        if (!kept.some((item) => iou(item, candidate) > 0.55)) kept.push(candidate)
        if (kept.length >= 8) break
    }
    return kept
}

function findInput(session, names) {
    return sessionInputs(session).find((item) => names.some((name) => item.name.toLowerCase().includes(name)))?.name
}

async function encodeMask(runtime, decoder, embedding, box, width, height) {
    const encoderSize = modelInputShape(sessions.encoder)[2] || 1024
    const coords = new Float32Array([
        box.x1 / width * encoderSize, box.y1 / height * encoderSize,
        box.x2 / width * encoderSize, box.y2 / height * encoderSize
    ])
    const labels = new Float32Array([2, 3])
    const feeds = {}
    const feature0 = tensor(runtime, 'float32', embedding.highRes0, embedding.highRes0Dims)
    const feature1 = tensor(runtime, 'float32', embedding.highRes1, embedding.highRes1Dims)
    const image = tensor(runtime, 'float32', embedding.image, embedding.imageDims)
    const pointCoords = tensor(runtime, 'float32', coords, [1, 2, 2])
    const pointLabels = tensor(runtime, 'float32', labels, [1, 2])
    const maskInput = tensor(runtime, 'float32', new Float32Array(1 * 1 * 256 * 256), [1, 1, 256, 256])
    const hasMaskInput = tensor(runtime, 'float32', new Float32Array([0]), [1])
    const originalSize = tensor(runtime, 'int32', new Int32Array([height, width]), [2])
    // SAM2 exports are not consistent about input ordering; map by semantic name.
    for (const input of sessionInputs(decoder)) {
        const name = input.name.toLowerCase()
        if (name.includes('image_embed') || name.includes('image_embedding')) feeds[input.name] = image
        else if (name.includes('high_res_feats_0') || name.includes('highres0')) feeds[input.name] = feature0
        else if (name.includes('high_res_feats_1') || name.includes('highres1')) feeds[input.name] = feature1
        else if (name.includes('point_coords') || name.includes('point_coordinates')) feeds[input.name] = pointCoords
        else if (name.includes('point_labels') || name.includes('point_label')) feeds[input.name] = pointLabels
        else if (name.includes('has_mask_input') || name.includes('hasmaskinput')) feeds[input.name] = hasMaskInput
        else if (name.includes('mask_input') || name.includes('maskinput')) feeds[input.name] = maskInput
        else if (name.includes('orig_im_size') || name.includes('original_image_size')) feeds[input.name] = originalSize
    }
    // Keep support for a positional export with opaque names.
    const fallbackValues = [feature0, feature1, image, pointCoords, pointLabels, maskInput, hasMaskInput, originalSize]
    sessionInputs(decoder).forEach((input, index) => { if (!feeds[input.name]) feeds[input.name] = fallbackValues[index] })
    const result = await decoder.run(feeds)
    const output = sessionOutputs(decoder).map((item) => result[item.name]).find((item) => item?.data && item.dims?.length >= 3)
    if (!output) throw new Error('SAM 2 decoder 没有返回 mask')
    const maskWidth = Number(output.dims.at(-1))
    const maskHeight = Number(output.dims.at(-2))
    const channels = Number(output.dims.at(-3)) || 1
    const source = output.data
    const alpha = Buffer.alloc(width * height)
    const channelOffset = channels > 1 ? 0 : 0
    for (let y = 0; y < height; y += 1) {
        const sy = Math.min(maskHeight - 1, Math.floor(y / height * maskHeight))
        for (let x = 0; x < width; x += 1) {
            const sx = Math.min(maskWidth - 1, Math.floor(x / width * maskWidth))
            const value = Number(source[channelOffset * maskWidth * maskHeight + sy * maskWidth + sx])
            alpha[y * width + x] = (value > 0 || (value >= 0 && sigmoid(value) > 0.5)) ? 255 : 0
        }
    }
    return alpha
}

async function runBundledModels(runtime, loaded, info) {
    sharpRuntime ||= loadPackage('sharp')
    const {info: metadata} = await sharpRuntime(info.buffer).removeAlpha().raw().toBuffer({resolveWithObject: true})
    const input = await imageTensor(runtime, info.buffer, loaded.detector, {normalize: false})
    const detectorInput = sessionInputs(loaded.detector)[0].name
    const detectorResult = await loaded.detector.run({[detectorInput]: input.tensor})
    const detectorOutput = sessionOutputs(loaded.detector).map((item) => detectorResult[item.name]).find((item) => item?.data)
    const boxes = detectPeople(runtime, loaded.detector, detectorOutput, metadata.width, metadata.height)
    if (!boxes.length) throw Object.assign(new Error('未检测到人物'), {code: 'NO_PERSON_DETECTED'})

    const encoderInput = await imageTensor(runtime, info.buffer, loaded.encoder)
    const encoded = await loaded.encoder.run({[sessionInputs(loaded.encoder)[0].name]: encoderInput.tensor})
    const outputValues = sessionOutputs(loaded.encoder).map((item) => encoded[item.name])
    const embedding = {
        highRes0: outputValues[0].data, highRes0Dims: outputValues[0].dims,
        highRes1: outputValues[1].data, highRes1Dims: outputValues[1].dims,
        image: outputValues[2].data, imageDims: outputValues[2].dims
    }
    const mask = Buffer.alloc(metadata.width * metadata.height)
    for (const box of boxes) {
        const part = await encodeMask(runtime, loaded.decoder, embedding, box, metadata.width, metadata.height)
        for (let index = 0; index < mask.length; index += 1) mask[index] = Math.max(mask[index], part[index])
    }
    // OpenAI image edits replace transparent pixels. Keep the background opaque
    // and make only the detected people transparent.
    const rgba = Buffer.alloc(mask.length * 4)
    for (let index = 0; index < mask.length; index += 1) {
        const offset = index * 4
        rgba[offset] = 255
        rgba[offset + 1] = 255
        rgba[offset + 2] = 255
        rgba[offset + 3] = mask[index] > 0 ? 0 : 255
    }
    const maskPng = await sharpRuntime(rgba, {raw: {width: metadata.width, height: metadata.height, channels: 4}}).png().toBuffer()
    return {mask: maskPng, boxes}
}

/**
 * The model adapter is deliberately isolated from HTTP and batch orchestration.
 * The shipped ONNX bundle follows the SAM2 encoder/decoder contract. Keeping
 * this boundary small lets us update model weights without changing the app.
 */
async function inferPersonMask(info) {
    const state = await modelState()
    const loaded = await loadRuntime(state)
    if (!loaded) {
        const error = new Error('未安装本地人物检测和 SAM 2 模型')
        error.code = 'VISION_MODELS_NOT_INSTALLED'
        error.models = state
        throw error
    }

    return runBundledModels(runtime, loaded, info)
}

export async function visionStatus() {
    const state = await modelState()
    return {
        ok: true,
        ready: state.ready,
        modelDir: state.directory,
        models: state.files,
        runtime: Boolean(runtime)
    }
}

export async function createPersonMask(image, options = {}) {
    const info = await imageInfo(image)
    const result = await inferPersonMask(info, options)
    if (!result?.mask) throw Object.assign(new Error('视觉模型没有返回 mask'), {code: 'VISION_EMPTY_MASK'})
    const maskBuffer = Buffer.isBuffer(result.mask) ? result.mask : Buffer.from(result.mask)
    return {
        mask: dataUrl(maskBuffer),
        width: info.width,
        height: info.height,
        boxes: Array.isArray(result.boxes) ? result.boxes : [],
        model: 'detector+sam2'
    }
}

export {parseDataUrl, dataUrl}
