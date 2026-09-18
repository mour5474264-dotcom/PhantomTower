import axios from 'axios'
import {getModels, getSettings} from '../api'
import {defaultConfig} from '../canvas/stores/use-config-store'
import {createVideoGenerationTask, pollVideoGenerationTask, unwrapVideoResponse} from '../canvas/services/api/video'
import {localGenerationUrl, localServerHeaders} from '../canvas/services/api/local-server'
import {VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, videoRatioOptions} from '../canvas/lib/media-size'

export {pollVideoGenerationTask}

// Use the same configured list as the canvas; custom model names must remain selectable.
export async function loadVideoModels() {
  const [models, settings] = await Promise.all([getModels(), getSettings()])
  return models.map(item => {
    const api = settings.apis?.find(api => api.id === item.upstreamId)
    const configured = api?.models?.find(model => `${api.id}:${model.id}` === item.id)
    const name = configured?.modelName || item.modelName || item.name || item.id
    const h3 = /^minimax-h3(?:-|$)/i.test(name)
    return {
      id: item.id, name: item.name || name, h3,
      apiFormat: !h3 && (item.provider === 'gemini' || item.protocol?.startsWith('gemini')) ? 'gemini' : 'openai',
    }
  })
}

export function videoConfig(model, form) {
  return {
    ...defaultConfig, channelMode: 'local', baseUrl: '', apiKey: '',
    channels: [{id: 'video-workbench', name: '视频工作台', baseUrl: '', apiKey: '', apiFormat: model.apiFormat,
      models: [{name: model.id, capability: 'video', apiFormat: model.apiFormat}]}],
    models: [model.id], model: model.id, videoModel: model.id, apiFormat: model.apiFormat,
    size: form.ratio, vquality: form.resolution, videoSeconds: String(form.seconds),
    videoMode: form.mode === 'reference' ? 'reference' : 'frames',
    videoGenerateAudio: String(form.audio), videoWatermark: String(form.watermark),
  }
}

export function referenceImages(form) {
  return form.mode === 'text' ? [] : form.mode === 'frames' ? [form.firstFrame, form.lastFrame].filter(Boolean) : form.images
}

export function mediaUrls(value) {
  return value.split(/\r?\n/).map(url => url.trim()).filter(Boolean)
}

export function validateVideoForm(model, form) {
  if (!model) throw new Error('请选择模型；未配置时请先前往 API 管理。')
  if (!form.prompt.trim()) throw new Error('请输入视频提示词。')
  const ratios = model.h3 ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'] : videoRatioOptions.map(item => item.value)
  if (!ratios.includes(form.ratio)) throw new Error('请为当前模型重新选择画面比例。')
  if (!model.h3 && (!Number.isInteger(form.seconds) || form.seconds < VIDEO_SECONDS_MIN || form.seconds > VIDEO_SECONDS_MAX)) throw new Error(`视频时长请输入 ${VIDEO_SECONDS_MIN}–${VIDEO_SECONDS_MAX} 之间的整数。`)
  if (form.mode === 'frames' && !form.firstFrame) throw new Error('首尾帧模式请先上传首帧，尾帧可选。')
  if (form.mode === 'reference' && !form.images.length && !form.videoUrls.trim() && !form.audioUrls.trim()) throw new Error('请添加参考图片、视频或音频。')
  const videos = form.mode === 'reference' ? mediaUrls(form.videoUrls) : []
  const audios = form.mode === 'reference' ? mediaUrls(form.audioUrls) : []
  if ([...videos, ...audios].some(value => { try { return new URL(value).protocol !== 'https:' } catch { return true } })) throw new Error('参考视频和音频请填写完整的 HTTPS 地址，每行一个。')
  if (model.h3) {
    if (!Number.isInteger(form.seconds) || form.seconds < 10 || form.seconds > 15) throw new Error('H3 视频时长为 10–15 秒，请调整时长。')
    if (referenceImages(form).length > 9 || videos.length > 3 || audios.length > 3 || referenceImages(form).length + videos.length + audios.length > 12) throw new Error('H3 最多支持 9 张图片、3 个视频、3 个音频，合计不超过 12 个素材。')
  }
  if (model.apiFormat === 'gemini' && (videos.length > 1 || audios.length > 1)) throw new Error('当前 Gemini 适配支持最多 1 个视频和 1 个音频参考。')
}

export async function createWorkbenchVideo(model, form, config) {
  const references = referenceImages(form)
  const videos = form.mode === 'reference' ? mediaUrls(form.videoUrls) : []
  const audios = form.mode === 'reference' ? mediaUrls(form.audioUrls) : []
  if (model.h3) {
    // H3 accepts public media URLs directly; do not download them in the browser.
    const response = await axios.post(localGenerationUrl('video', model.id), {
      prompt: form.prompt.trim(), seconds: form.seconds, ratio: form.ratio,
      images: references.map(image => image.dataUrl),
      metadata: {video_urls: videos, audio_urls: audios},
    }, {headers: await localServerHeaders()})
    const task = unwrapVideoResponse(response.data)
    if (!task.id) throw new Error('服务商未返回任务 ID，请先核对服务商记录。')
    return {id: task.id, model: model.id, provider: 'openai'}
  }
  const media = (urls, type) => urls.map((url, index) => ({id: String(index), name: `reference-${index}.${type}`, url}))
  return createVideoGenerationTask(config, form.prompt.trim(), references, {videos: media(videos, 'mp4'), audios: media(audios, 'mp3')})
}
