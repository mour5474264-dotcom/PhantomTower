const fail = (message) => { throw Object.assign(new Error(message), {status: 400}) }
export const isMinimaxH3 = (model) => /^minimax-h3(?:-|$)/i.test(model)

// This relay's H3 endpoint accepts JSON, not OpenAI's multipart video schema.
export async function minimaxVideoPayload(form, model) {
    // Standalone pages can submit the documented JSON body directly.
    if (!(form instanceof FormData)) {
        const input = form || {}
        const converted = new FormData()
        for (const key of ['prompt', 'seconds']) if (input[key] !== undefined) converted.set(key, String(input[key]))
        converted.set('ratio', String(input.ratio || input.aspect_ratio || '16:9'))
        for (const [key, values] of [
            ['image[]', input.images],
            ['video_url[]', input.metadata?.video_urls ?? input.metadata?.videos],
            ['audio_url[]', input.metadata?.audio_urls ?? input.metadata?.audios],
        ]) {
            if (values !== undefined && (!Array.isArray(values) || values.some(value => typeof value !== 'string'))) fail(`${key} 必须是字符串数组`)
            for (const value of values || []) converted.append(key, value)
        }
        form = converted
    }
    const seconds = Math.max(10, Math.min(15, Math.round(Number(form.get('seconds')) || 10)))
    const ratio = String(form.get('ratio') || '16:9')
    if (!['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'].includes(ratio)) fail('H3 不支持该画幅，请选择 16:9、9:16、1:1、4:3、3:4、21:9、3:2 或 2:3')
    const prompt = String(form.get('prompt') || '').trim()
    if (!prompt) fail('请输入视频提示词')
    const images = [...form.getAll('image[]'), ...form.getAll('first_frame'), ...form.getAll('last_frame')]
    const media = (kind) => {
        const files = form.getAll(`${kind}[]`)
        const urls = form.getAll(`${kind}_url[]`).map(String)
        if (files.length && files.length !== urls.length) fail('H3 的视频和音频参考需要公网 HTTPS 地址，请使用已上传到公网的素材')
        if (urls.some((value) => { try { return new URL(value).protocol !== 'https:' } catch { return true } })) fail('H3 的视频和音频参考需要公网 HTTPS 地址')
        return urls
    }
    const videos = media('video'), audios = media('audio')
    if (images.length > 9 || videos.length > 3 || audios.length > 3 || images.length + videos.length + audios.length > 12) fail('H3 最多支持 9 张图片、3 个视频、3 个音频，混合素材总数不超过 12')
    const encoded = await Promise.all(images.map(async (image) => {
        if (typeof image === 'string') return image
        return `data:${image.type || 'image/png'};base64,${Buffer.from(await image.arrayBuffer()).toString('base64')}`
    }))
    return {model, prompt, seconds, ratio, ...(encoded.length ? {images: encoded} : {}), ...(videos.length || audios.length ? {metadata: {...(videos.length ? {video_urls: videos} : {}), ...(audios.length ? {audio_urls: audios} : {})}} : {})}
}
