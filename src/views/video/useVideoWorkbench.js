import {computed, onActivated, onDeactivated, onMounted, onBeforeUnmount, ref, watch} from 'vue'
import localforage from 'localforage'
import {ElMessage} from 'element-plus'
import {loadVideoModels, videoConfig, validateVideoForm, createWorkbenchVideo, pollVideoGenerationTask} from '../../services/video-workbench'
import {isRetryableVideoQuery, videoQueryRetryDelay} from '../../services/video-poll-retry'

const recordsStore = localforage.createInstance({name: 'sample-factory-video', storeName: 'records'})
const draftStore = localforage.createInstance({name: 'sample-factory-video', storeName: 'draft'})
const freshForm = () => ({model: '', prompt: '', mode: 'text', seconds: 10, ratio: '16:9', resolution: '720', audio: true, watermark: false, images: [], firstFrame: null, lastFrame: null, videoUrls: '', audioUrls: ''})
const clone = value => JSON.parse(JSON.stringify(value))
export const statusLabels = {submitting: '正在提交', unknown: '提交结果待确认', pending: '生成中', paused: '查询已暂停', completed: '已完成', failed: '生成失败'}

export function useVideoWorkbench() {
  const form = ref(freshForm())
  const models = ref([])
  const modelError = ref('')
  const loadingModels = ref(false)
  const ready = ref(false)
  const submitting = ref(false)
  const importing = ref(false)
  const records = ref([])
  const selectedId = ref('')
  const previewUrl = ref('')
  const activeIds = ref(new Set())
  const model = computed(() => models.value.find(item => item.id === form.value.model))
  const selected = computed(() => records.value.find(record => record.id === selectedId.value))
  const controllers = new Map()
  let active = true
  let draftTimer
  let modelRequest = 0
  let objectUrl = ''
  const report = error => ElMessage.error(error?.message || String(error))

  async function refreshModels() {
    const request = ++modelRequest
    loadingModels.value = true
    modelError.value = ''
    try {
      const next = await loadVideoModels()
      if (request !== modelRequest) return
      models.value = next
      if (!next.some(item => item.id === form.value.model)) form.value.model = next[0]?.id || ''
    } catch (error) {
      if (request !== modelRequest) return
      models.value = []
      modelError.value = error.message || '模型读取失败'
    } finally {
      if (request === modelRequest) loadingModels.value = false
    }
  }

  async function persist(record) {
    // Keep a task usable in memory even if disk space runs out after creation.
    await recordsStore.setItem(record.id, {...clone({...record, blob: undefined}), ...(record.blob ? {blob: record.blob} : {})})
  }

  async function persistDraft() {
    clearTimeout(draftTimer)
    if (!ready.value) return
    try { await draftStore.setItem('current', clone(form.value)) }
    catch { ElMessage.error('视频草稿保存失败，请检查本地存储空间。') }
  }
  watch(form, () => {
    if (!ready.value) return
    clearTimeout(draftTimer)
    draftTimer = setTimeout(persistDraft, 400)
  }, {deep: true})

  watch(() => [selected.value?.id, selected.value?.blob, selected.value?.url], () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = selected.value?.blob ? URL.createObjectURL(selected.value.blob) : ''
    previewUrl.value = objectUrl || selected.value?.url || ''
  })

  function waitForPoll(signal, milliseconds = 4000) {
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, milliseconds)
      signal.addEventListener('abort', finish, {once: true})
      if (signal.aborted) finish()
    })
  }

  async function poll(record) {
    if (!active || !record.task || controllers.has(record.id) || record.status === 'completed' || record.status === 'failed') return
    const controller = new AbortController()
    controllers.set(record.id, controller)
    activeIds.value.add(record.id)
    record.status = 'pending'
    record.error = ''
    try {
      await persist(record)
      let failures = 0
      // Preserve the query window, but tolerate temporary transport failures.
      for (let attempt = 0; attempt < 120 && !controller.signal.aborted; attempt++) {
        let state
        try {
          state = await pollVideoGenerationTask(record.config, record.task, {signal: controller.signal})
          failures = 0
          record.error = ''
        } catch (error) {
          if (controller.signal.aborted) return
          if (!isRetryableVideoQuery(error)) throw error
          failures++
          if (failures >= 10) throw new Error(`连续 10 次查询未成功，可稍后继续查询原任务。最近错误：${error.message}`)
          const delay = videoQueryRetryDelay(failures)
          record.error = `查询暂时失败，${delay / 1000} 秒后自动重试（第 ${failures} 次）；任务未重新提交。${error.message || ''}`
          if (attempt < 119) await waitForPoll(controller.signal, delay)
          continue
        }
        if (controller.signal.aborted) return
        if (state.status === 'completed') {
          record.blob = state.result.blob
          record.url = state.result.url || ''
          record.status = 'completed'
          await persist(record)
          return
        }
        if (state.status === 'failed') {
          record.status = 'failed'
          record.error = state.error
          await persist(record)
          return
        }
        if (attempt < 119) await waitForPoll(controller.signal)
      }
      if (!controller.signal.aborted) {
        record.status = 'paused'
        record.error = '本轮查询已结束，任务可能仍在生成。可继续查询，不会重复提交。'
        await persist(record)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      if (record.status === 'completed') {
        record.error = '视频已生成，但本地保存失败，请立即下载视频。'
        report(new Error(record.error))
      } else {
        if (record.status !== 'failed') record.status = 'paused'
        record.error = error.message || '查询中断，请继续查询。'
        await persist(record).catch(() => report(new Error('任务记录保存失败，请保留当前页面和任务 ID。')))
      }
    } finally {
      controllers.delete(record.id)
      activeIds.value.delete(record.id)
      if (active && record.status === 'pending') void poll(record)
    }
  }

  async function pause(record) {
    record.status = 'paused'
    record.error = '已停止查询；服务商可能仍在生成，可随时继续查询。'
    controllers.get(record.id)?.abort()
    try { await persist(record) } catch (error) { report(error) }
  }

  async function generate() {
    if (submitting.value || importing.value || !ready.value || loadingModels.value) return
    let record
    let sent = false
    submitting.value = true
    try {
      const snapshot = clone(form.value)
      const selectedModel = model.value && {...model.value}
      validateVideoForm(selectedModel, snapshot)
      const config = videoConfig(selectedModel, snapshot)
      clearTimeout(draftTimer)
      await draftStore.setItem('current', snapshot)
      record = {id: crypto.randomUUID(), createdAt: Date.now(), status: 'submitting', modelName: selectedModel.name,
        form: snapshot, config, task: null, error: ''}
      await persist(record)
      records.value.unshift(record)
      record = records.value[0]
      selectedId.value = record.id
      sent = true
      record.task = await createWorkbenchVideo(selectedModel, snapshot, config)
      record.status = 'pending'
      try { await persist(record) }
      catch { record.status = 'paused'; throw new Error('任务已提交，但保存失败。请保留任务 ID，释放本地空间后继续查询。') }
      void poll(record)
    } catch (error) {
      if (record && records.value.some(item => item.id === record.id)) {
        // A transport failure does not prove the provider rejected the POST.
        record.status = record.task ? 'paused' : sent ? 'unknown' : 'failed'
        record.error = error.message || '任务提交失败'
        await persist(record).catch(() => {})
      }
      report(error)
    } finally { submitting.value = false }
  }

  async function addImages(files, target = 'images') {
    if (importing.value) return
    importing.value = true
    try {
      const chosen = Array.from(files || [])
      if (chosen.some(file => !file.type.startsWith('image/'))) throw new Error('这里只接受图片文件。')
      if (target !== 'images' && chosen.length > 1) throw new Error('每个帧位置只能选择一张图片。')
      const images = await Promise.all(chosen.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({id: crypto.randomUUID(), name: file.name, type: file.type, dataUrl: reader.result})
        reader.onerror = () => reject(new Error(`无法读取 ${file.name}`))
        reader.readAsDataURL(file)
      })))
      if (target === 'images') form.value.images.push(...images)
      else if (images[0]) form.value[target] = images[0]
    } catch (error) { report(error) }
    finally { importing.value = false }
  }

  function restore(record) {
    form.value = clone(record.form)
    if (!models.value.some(item => item.id === form.value.model)) {
      form.value.model = ''
      ElMessage.warning('原模型不在当前工作台，请切换工作台或重新选择模型。')
    }
    ElMessage.success('参数和素材已填入，可编辑后生成。')
  }

  async function removeRecord(record) {
    if (controllers.has(record.id) || record.status === 'submitting') return
    try {
      await recordsStore.removeItem(record.id)
      records.value = records.value.filter(item => item.id !== record.id)
      if (selectedId.value === record.id) selectedId.value = records.value[0]?.id || ''
    } catch (error) { report(error) }
  }

  function download() {
    if (!previewUrl.value) return
    const link = document.createElement('a')
    link.href = previewUrl.value
    link.download = `视频-${selected.value.id}.mp4`
    link.rel = 'noopener'
    if (!objectUrl) link.target = '_blank'
    link.click()
  }

  function deactivate() {
    active = false
    for (const controller of controllers.values()) controller.abort()
    void persistDraft()
  }
  onActivated(() => {
    active = true
    if (ready.value) {
      void refreshModels()
      records.value.filter(record => record.status === 'pending').forEach(record => void poll(record))
    }
  })
  onDeactivated(deactivate)
  onMounted(async () => {
    window.addEventListener('sample-factory-active-api-changed', refreshModels)
    try {
      const [draft] = await Promise.all([draftStore.getItem('current'), recordsStore.iterate(record => { records.value.push(record) })])
      if (draft) form.value = {...freshForm(), ...draft}
      records.value.sort((a, b) => b.createdAt - a.createdAt)
      for (const record of records.value) if (record.status === 'submitting') {
        record.status = 'unknown'
        record.error = '上次提交中断，无法确认是否已受理。请先核对服务商记录，不要直接重复提交。'
        await persist(record)
      }
      selectedId.value = records.value[0]?.id || ''
      ready.value = true
      await refreshModels()
      records.value.filter(record => record.status === 'pending').forEach(record => void poll(record))
    } catch (error) { report(new Error(`无法读取视频记录：${error.message}。请检查本地存储后重新打开页面。`)) }
  })
  onBeforeUnmount(() => {
    deactivate()
    window.removeEventListener('sample-factory-active-api-changed', refreshModels)
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  })

  return {form, models, model, modelError, loadingModels, ready, submitting, importing, records, selectedId, selected,
    previewUrl, activeIds, refreshModels, generate, addImages, pause, poll, restore, removeRecord, download}
}
