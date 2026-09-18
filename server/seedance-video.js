const fail = (message) => { throw Object.assign(new Error(message), {status: 400}) }

// Match the documented public model only; sd2.* aliases have separate contracts.
export const isSeedance20 = (model) => model === 'doubao-seedance-2-0-260128'

export async function seedanceVideoPayload(input, model) {
    const multipart = input instanceof FormData
    const get = (key) => multipart ? input.get(key) : input?.[key]
    const prompt = String(get('prompt') || '').trim()
    if (!prompt) fail('请输入视频提示词')
    const duration = Number(get('duration') ?? get('seconds'))
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) fail('Seedance 2.0 时长必须是 4–15 秒的整数')
    const ratio = String(get('ratio') || get('aspect_ratio') || '16:9')
    if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'].includes(ratio)) fail('Seedance 2.0 不支持该画幅')
    // The supplied public schema lists image fields only. Do not guess private
    // video/audio fields even though the model description mentions support.
    const media = multipart
        ? ['video[]', 'audio[]', 'video_url[]', 'audio_url[]'].some(key => input.getAll(key).length)
        : ['videos', 'audios', 'video_url', 'audio_url', 'video_urls', 'audio_urls'].some(key => get(key)?.length)
            || Object.values(input?.metadata || {}).some(value => value?.length)
    if (media) fail('当前 Seedance 2.0 文档未提供视频、音频参考的请求字段，请先使用文本或图片参考')
    const images = multipart
        ? [...input.getAll('image[]'), ...input.getAll('first_frame'), ...input.getAll('last_frame')]
        : get('images') ?? (get('image_url') ? [get('image_url')] : [])
    if (!Array.isArray(images) || images.length > 9) fail('Seedance 2.0 最多支持 9 张参考图片')
    const encoded = await Promise.all(images.map(async image => {
        if (image instanceof Blob && image.type.startsWith('image/')) {
            return `data:${image.type};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`
        }
        if (typeof image === 'string' && (/^https:\/\//i.test(image) || /^data:image\/[^;]+;base64,/i.test(image))) return image
        fail('Seedance 2.0 参考图片需要 HTTPS 地址或图片 data URI')
    }))
    return {model, prompt, duration, ratio, ...(encoded.length ? {images: encoded} : {})}
}
