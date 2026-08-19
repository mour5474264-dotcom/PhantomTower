<script setup>
import {ref, computed, onMounted, onBeforeUnmount, markRaw} from 'vue'
import {Delete, Upload, Refresh, VideoPlay, VideoPause, Download} from '@element-plus/icons-vue'
import {ElMessage} from 'element-plus'
import {X, Plus, ImagePlus, PenLine} from 'lucide-vue-next'
import {
  getModels,
  getPromptTemplates,
  getBuiltInPromptTemplates,
  generateImage,
  cancelGeneration,
  exportImages,
  prepareEditImage
} from '../api'

const URL = {
  createObjectURL(value) {
    return value?.previewUrl || (rawFile(value) ? globalThis.URL.createObjectURL(rawFile(value)) : '')
  }
}
const models = ref([]);
const presets = ref([]);
const builtInTemplates = ref([]);
const model = ref('');
const modelMode = ref('balanced');
const presetId = ref('');
const prompt = ref('');
const count = ref(1);
const resolution = ref('2K');
const format = ref('png');
const size = ref('reference');
const customWidth = ref(2048);
const customHeight = ref(2048);
const running = ref(false);
const completedCount = ref(0);
const generationTotal = ref(0);
const error = ref('');
const controller = ref(null);
const activeTaskId = ref('')
const generationQueue = []
const queuedCount = ref(0)
const preview = ref('')
const materials = ref({person: [], pose: [], prop: [], scene: [], reference: []})
const mode = ref('text')
const isTextMode = computed(() => mode.value === 'text')
const imageOperation = ref('batch')
const replaceObject = ref('')
const editParent = ref(null)

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file)
  })
}

async function getRequestSize(task, requestConfig) {
  if (requestConfig.size !== 'reference') return requestConfig.size === 'custom' ? `${requestConfig.customWidth}x${requestConfig.customHeight}` : requestConfig.size;
  const file = rawFile(task.item);
  if (!file || task.type === 'text') return '2048x2048';
  const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
  const ratio = bitmap.width / bitmap.height;
  bitmap.close();
  if (ratio > 1.15) return '2560x1440';
  if (ratio < 0.87) return '1440x2560';
  return '2048x2048';
}

const materialLabels = {
  person: '人物',
  prop: '道具',
  reference: '目标/构图',
  pose: '动作',
  scene: '场景'
}
const results = ref([]);
const selected = ref(new Set())
const exporting = ref(false)
const preparingEdit = ref(false)
const allResultsSelected = computed(() => results.value.length > 0 && selected.value.size === results.value.length)

const materialPreviewUrls = computed(() => Object.fromEntries(
    Object.entries(materials.value).map(([key, items]) => [key, items.map((item) => item.previewUrl || '')])
))
const progressTotal = computed(() => generationTotal.value || totalExpected.value || 0)
const progressPercent = computed(() => progressTotal.value ? Math.min(100, Math.round(completedCount.value / progressTotal.value * 100)) : 0)
const imageTaskCount = computed(() => buildImageTasks().length)
const taskCount = computed(() => isTextMode.value ? (prompt.value.trim() || preset.value ? 1 : 0) : imageTaskCount.value)
const totalExpected = computed(() => taskCount.value * Math.max(1, Number(count.value || 1)))
const imagesPerRequest = computed(() => Object.values(materials.value).reduce((total, items) => total + items.length, 0))
const sizeSummary = computed(() => {
  if (size.value === 'reference') return '自适应主目标图尺寸'
  if (size.value === 'custom') return `${customWidth.value} x ${customHeight.value}`
  return size.value
})
const expectedFormula = computed(() => {
  const copies = Math.max(1, Number(count.value || 1))
  if (isTextMode.value) return `1 个文字任务 x ${copies}`
  if (imageOperation.value === 'batch') return `${materials.value.reference.length} 张目标图 x ${copies}`
  return `1 个${operationLabel()}任务 x ${copies}`
})
const expectedState = computed(() => {
  if (isTextMode.value) return prompt.value.trim() ? '可以生成' : '请填写图像描述'
  return imageValidationError() || '可以生成'
})
const availableTemplates = computed(() => {
  const operation = isTextMode.value ? 'text' : imageOperation.value
  const all = [...builtInTemplates.value, ...presets.value.filter((item) => !builtInTemplates.value.some((base) => base.id === item.id))]
  return all.filter((item) => (item.mode === 'all' || item.mode === (isTextMode.value ? 'text' : 'image')) && (!item.operation || item.operation === 'all' || item.operation === operation))
})
const preset = computed(() => availableTemplates.value.find((item) => item.id === presetId.value))
const materialTypes = [
  {key: 'person', label: '人物参考', step: '可选', hint: '用于固定人物身份、脸部与服装', limit: 3},
  {key: 'reference', label: '目标 / 构图图', step: '任务', hint: '每张图片单独执行一次处理，可叠加背景和道具素材', limit: 30},
  {key: 'prop', label: '道具参考', step: '可选', hint: '用于影响每张目标图中的道具内容', limit: 30}
]
materialTypes.push({key: 'scene', label: '背景参考', step: '可选', hint: '用于影响每张目标图的背景与环境', limit: 30})
const activeMaterialTypes = computed(() => {
  const keys = {
    batch: ['person', 'reference', 'scene', 'prop'],
    fusion: ['person', 'reference', 'scene', 'prop'],
    background: ['reference', 'scene'],
    prop: ['reference', 'prop'],
    edit: ['reference']
  }[imageOperation.value] || []
  return materialTypes.filter((item) => keys.includes(item.key))
})

function rawFile(value) {
  return value?.raw instanceof File ? value.raw : value instanceof File ? value : value?.file instanceof File ? value.file : null
}

function referenceRole(key) {
  return key === 'reference' ? 'target_reference' : `${key}_reference`
}

function referencePromptLabel(key) {
  return ({
    person: '人物参考图',
    reference: '目标图/构图图',
    prop: '道具图',
    scene: '场景参考图',
    pose: '动作参考图'
  })[key] || '参考图'
}

async function buildLabeledReferences(task, materialSet = materials.value) {
  if (task?.type === 'text') return []
  const labeled = []
  const materialOrder = task.materialKeys || ['person', 'reference', 'pose', 'prop', 'scene']
  for (const key of materialOrder) {
    const items = key === 'reference' && task.item ? [task.item] : materialSet[key]
    for (const item of items) {
      const file = rawFile(item)
      if (!file) continue
      labeled.push({
        role: referenceRole(key),
        type: materialLabels[key],
        promptLabel: referencePromptLabel(key),
        primary: item === task?.item,
        data: await fileToDataUrl(file)
      })
    }
  }
  return labeled
}

function addFiles(key, upload) {
  const file = rawFile(upload);
  if (!file || !file.type?.startsWith('image/')) return;
  const limit = key === 'person' ? 3 : 30;
  if (materials.value[key].length >= limit) {
    error.value = `${materialLabels[key]}最多添加 ${limit} 张`;
    return;
  }
  if (materials.value[key].some((item) => item.name === file.name && item.size === file.size)) return;
  materials.value[key].push(markRaw({file, name: file.name, size: file.size, previewUrl: URL.createObjectURL(file)}))
}

function removeFile(key, index) {
  materials.value[key].splice(index, 1)
}

async function refresh() {
  try {
    models.value = await getModels();
    model.value ||= models.value[0]?.id || '';
  } catch (e) {
    error.value = e.message
  }
  try {
    presets.value = await getPromptTemplates();
    builtInTemplates.value = await getBuiltInPromptTemplates();
    presetId.value = availableTemplates.value.some((item) => item.id === presetId.value) ? presetId.value : ''
  } catch (e) {
    error.value = e.message
  }
}

function clearCurrent() {
  controller.value?.abort()
  controller.value = null
  running.value = false
  activeTaskId.value = ''
  Object.keys(materials.value).forEach((key) => {
    materials.value[key] = []
  });
  results.value = [];
  selected.value = new Set();
  prompt.value = '';
  replaceObject.value = '';
  editParent.value = null;
  presetId.value = '';
  count.value = 1;
  error.value = '';
  completedCount.value = 0;
  generationTotal.value = 0;
}

function setMode(nextMode) {
  if (mode.value === nextMode) return
  mode.value = nextMode
  error.value = ''
  completedCount.value = 0
  presetId.value = ''
  if (nextMode === 'text' && size.value === 'reference') size.value = '2048x2048'
}

function setImageOperation(nextOperation) {
  if (imageOperation.value === nextOperation) return
  imageOperation.value = nextOperation
  error.value = ''
  completedCount.value = 0
  presetId.value = ''
}

function operationLabel(operation = imageOperation.value) {
  return ({
    batch: '逐张批处理',
    fusion: '多图融合',
    background: '背景替换',
    prop: '道具替换',
    edit: '局部继续编辑'
  })[operation] || '图生图'
}

function buildImageTasks() {
  const target = materials.value.reference[0]
  if (imageOperation.value === 'batch') {
    return materials.value.reference.map((item, index) => ({
      // The target must be the first physical image: several image models use
      // the first input as the editing canvas despite the textual role labels.
      item, type: 'reference', label: `逐张处理 ${index + 1}`, materialKeys: ['reference', 'person', 'scene', 'prop']
    }))
  }
  if (!target) return []
  if (imageOperation.value === 'fusion') {
    return [{item: target, type: 'fusion', label: '多图融合', materialKeys: ['reference', 'person', 'scene', 'prop']}]
  }
  if (imageOperation.value === 'background') {
    return [{item: target, type: 'background', label: '背景替换', materialKeys: ['reference', 'scene']}]
  }
  if (imageOperation.value === 'edit') {
    return [{item: target, type: 'local-edit', label: '局部继续编辑', materialKeys: ['reference']}]
  }
  return [{item: target, type: 'prop-replace', label: '道具替换', materialKeys: ['reference', 'prop']}]
}

function imageValidationError() {
  if (!materials.value.reference.length) return `${operationLabel()}需要一张主目标图`
  if (imageOperation.value === 'background' && !materials.value.scene.length) return '背景替换需要一张背景参考图'
  if (imageOperation.value === 'edit' && !prompt.value.trim()) return '请说明需要修改的局部内容'
  if (imageOperation.value === 'prop') {
    if (!materials.value.prop.length) return '道具替换需要一张道具参考图'
    if (!replaceObject.value.trim()) return '请说明主目标图中需要替换的道具'
  }
  return ''
}

function buildMaterialPrompt(labeled, taskType = 'text', taskLabel = '提示词变化', replaceObjectText = '', configuredRule = '') {
  if (!labeled.length) return '';
  const primary = labeled.find((item) => item.primary)
  const manifest = ['提示词可直接使用“人物参考图”“目标图/构图图”“道具图”“场景参考图”“动作参考图”指代对应类别，无需使用图片序号。', '本次请求会同时发送以上全部参考图；本次主参考图是“' + (primary?.promptLabel || '无') + '”。当规则提到目标图、构图图或主参考图时，均以该图片为准。', ...labeled.map((item, index) => `图片${index + 1}：${item.promptLabel}${item.primary ? '（本次主参考图）' : ''}（${item.role}）`)].join('\n');
  const defaultRule = taskType === 'reference'
      ? '以主目标图为画面基础，保持其构图、动作、位置、遮挡和透视。人物参考图只提供人物身份与外观；如上传背景参考图，则将其环境、场景氛围和背景元素融入主目标图；如上传道具图，则将其作为画面中人物自然使用或呈现的道具。未上传的人物、背景或道具素材不作替换要求。'
      : taskType === 'pose'
          ? '保持人物参考中的同一人物，采用最后一张动作参考的姿势和身体朝向；不得带入动作参考人物的身份、脸部和背景。'
          : taskType === 'prop'
              ? '保持人物参考中的同一人物，让人物自然使用最后一张道具参考中的道具；不得带入道具图中的无关人物和背景。'
              : taskType === 'fusion'
                  ? '以主目标图作为画布结构，把人物、背景和道具参考融合到同一画面。主目标图决定构图、透视、遮挡和光线，其余素材只能用于对应角色。'
                  : taskType === 'background'
                      ? '只替换主目标图中人物背后的环境。保持人物、前景遮挡、人物比例、位置、镜头和光线关系不变。'
                      : taskType === 'prop-replace'
                          ? `只替换主目标图中的“${replaceObjectText.trim()}”。保持其他主体、位置、比例、透视、接触关系和光线不变，不生成额外道具。`
                          : taskType === 'local-edit'
                              ? '只修改用户指定的局部内容。保持未提及区域的主体、构图、位置、比例、透视、遮挡和光线不变，不重绘整张图片。'
                              : '只根据补充提示词为人物参考中的同一人物创建一个新变化。';
  const batchMaterialRule = taskType === 'reference' ? [
    labeled.some((item) => item.role === 'scene_reference') && '背景参考图是必须使用的视觉来源：将背景图中可辨识的场景、地点、室内外环境、主要背景物体、色调和氛围融入主目标图背景，不得忽略或以无关背景替代。',
    labeled.some((item) => item.role === 'prop_reference') && '道具图是必须使用的视觉来源：在主目标图中清晰呈现道具图里的主要道具，保留其可辨识的外形、材质、颜色和关键细节，并使其与人物或画面自然接触；不得省略、替换为其他道具或只保留相似概念。'
  ].filter(Boolean).join('\n') : '';
  const rule = [configuredRule, defaultRule, batchMaterialRule].filter(Boolean).join('\n\n');
  return `【本次只处理一个任务：${taskLabel}】\n${manifest}\n\n【执行规则】\n${rule}`;
}

function buildTasks() {
  if (isTextMode.value && preset.value && !prompt.value.trim()) return [{item: null, type: 'text', label: '文生图'}]
  if (isTextMode.value) return prompt.value.trim() ? [{item: null, type: 'text', label: '文字生图'}] : []
  return buildImageTasks()
}

function createGenerationWork() {
  const imageError = isTextMode.value ? '' : imageValidationError()
  if (imageError) {
    error.value = imageError;
    return null
  }
  if (!model.value) {
    error.value = '请先选择生成模型';
    return null
  }
  if (!taskCount.value) {
    error.value = isTextMode.value ? '请填写图像描述' : '请添加目标构图、动作、道具，或填写补充提示词';
    return null
  }
  error.value = '';
  const tasks = buildTasks()
  const requestConfig = {
    model: model.value,
    prompt: prompt.value,
    presetId: presetId.value || null,
    mode: isTextMode.value ? 'text' : 'image',
    quality: modelMode.value === 'quality' ? 'high' : 'medium',
    size: size.value,
    customWidth: customWidth.value,
    customHeight: customHeight.value,
    replaceObject: replaceObject.value,
    format: format.value,
    resolution: resolution.value
  }
  const materialSnapshot = Object.fromEntries(
    Object.entries(materials.value).map(([key, items]) => [key, [...items]])
  )
  const jobs = tasks.flatMap((task) =>
      Array.from({length: count.value}, (_, copyIndex) => ({task, copyIndex}))
  );
  generationTotal.value = jobs.length
  const resultStart = results.value.length
  results.value.push(...jobs.map(({task}, index) => ({
    id: `result-${Date.now()}-${resultStart + index}`,
    loading: true,
    status: index === 0 ? 'generating' : 'waiting',
    label: task.label,
    task
  })));
  return {tasks, jobs, resultStart, requestConfig, materialSnapshot, copies: Number(count.value)}
}

async function runGeneration(work) {
  completedCount.value = 0;
  generationTotal.value = work.jobs.length
  controller.value = new AbortController();
  try {
    let jobIndex = 0;
    for (const task of work.tasks) {
      const labeled = await buildLabeledReferences(task, work.materialSnapshot)
      const selectedTemplate = availableTemplates.value.find((item) => item.id === work.requestConfig.presetId)
      const materialPrompt = buildMaterialPrompt(labeled, task.type, task.label, work.requestConfig.replaceObject, selectedTemplate?.systemPrompt || '');
      const requestSize = await getRequestSize(task, work.requestConfig);
      const taskId = crypto.randomUUID()
      for (let index = 0; index < work.copies; index += 1) {
        if (controller.value.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const resultIndex = work.resultStart + jobIndex
        results.value[resultIndex] = {...results.value[resultIndex], status: 'generating'};
        const requestSnapshot = {
          model: work.requestConfig.model,
          prompt: materialPrompt,
          extraPrompt: work.requestConfig.prompt,
          presetId: work.requestConfig.presetId,
          mode: work.requestConfig.mode,
          images: labeled.map((item) => item.data),
          materials: labeled,
          n: 1,
          size: requestSize,
          quality: work.requestConfig.quality,
          format: work.requestConfig.format,
          resolution: work.requestConfig.resolution,
          mask: '',
          taskId,
          parentResultId: task.type === 'local-edit' ? editParent.value?.id || null : null,
          version: task.type === 'local-edit' ? Number(editParent.value?.version || 0) + 1 : 1,
          operation: task.type
        }
        activeTaskId.value = taskId
        const response = await generateImage(requestSnapshot, {signal: controller.value.signal});
        const output = response.data?.[0];
        results.value[resultIndex] = {
          id: results.value[resultIndex]?.id || `result-${Date.now()}-${resultIndex}`,
          loading: false,
          imageLoading: Boolean(output?.url),
          url: output?.url || (output?.b64_json ? `data:image/png;base64,${output.b64_json}` : ''),
          label: task.label,
          task,
          id: output?.id || results.value[resultIndex]?.id,
          taskId: output?.taskId || taskId,
          parentResultId: output?.parentResultId || null,
          version: output?.version || 1,
          requestSnapshot
        };
        completedCount.value += 1
        jobIndex += 1;
        if (results.value[work.resultStart + jobIndex]) results.value[work.resultStart + jobIndex] = {...results.value[work.resultStart + jobIndex], status: 'generating'};
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') error.value = e.message;
    results.value.slice(work.resultStart, work.resultStart + work.jobs.length).forEach((item, offset) => {
      if (item?.loading) results.value[work.resultStart + offset] = {...item, loading: false, status: 'failed', error: e.message || '生成失败'}
    })
  } finally {
    controller.value = null
    activeTaskId.value = ''
  }
}

async function generate() {
  const work = createGenerationWork()
  if (!work) return
  generationQueue.push(work)
  queuedCount.value = generationQueue.length
  if (running.value) return

  running.value = true
  while (generationQueue.length && running.value) {
    const nextWork = generationQueue.shift()
    queuedCount.value = generationQueue.length
    await runGeneration(nextWork)
  }
  running.value = false
}

async function stop() {
  const taskId = activeTaskId.value
  if (taskId) {
    try {
      await cancelGeneration(taskId)
    } catch {
      // Browser cancellation below remains available if the local server is unavailable.
    }
  }
  controller.value?.abort();
  generationQueue.splice(0)
  queuedCount.value = 0
  running.value = false;
  results.value = results.value.map((item) => item.loading
    ? {...item, loading: false, status: 'stopped', error: '已停止生成'}
    : item)
  error.value = '已停止生成'
}

function toggle(index) {
  if (!results.value[index]) return
  const next = new Set(selected.value)
  next.has(index) ? next.delete(index) : next.add(index)
  selected.value = next
}

function toggleSelectAll() {
  if (allResultsSelected.value) {
    selected.value = new Set()
    return
  }
  selected.value = new Set(results.value.map((_, index) => index))
}

function removeSelected() {
  if (!selected.value.size || running.value) return
  const selectedIndexes = selected.value
  results.value = results.value.filter((_, index) => !selectedIndexes.has(index))
  selected.value = new Set()
}

async function continueEdit() {
  if (selected.value.size !== 1 || running.value || preparingEdit.value) return
  const index = [...selected.value][0]
  const result = results.value[index]
  if (!result?.url) return
  preparingEdit.value = true
  try {
    error.value = ''
    const prepared = await prepareEditImage(result.url)
    const response = await fetch(prepared.url)
    if (!response.ok) throw new Error('无法读取已选样片')
    const blob = await response.blob()
    const file = new File([blob], `sample-${Date.now()}.${format.value}`, {type: blob.type || 'image/png'})
    Object.keys(materials.value).forEach((key) => {
      materials.value[key] = []
    })
    materials.value.reference = [markRaw({
      file,
      name: file.name,
      size: file.size,
      previewUrl: URL.createObjectURL(file)
    })]
    mode.value = 'image'
    imageOperation.value = 'edit'
    editParent.value = result
    prompt.value = ''
    size.value = 'reference'
    presetId.value = ''
    selected.value = new Set()
    ElMessage.success('已将选中样片设为编辑基础图')
  } catch (e) {
    error.value = e.message || '无法读取已选样片'
  } finally {
    preparingEdit.value = false
  }
}

async function restoreHistoryEdit() {
  const saved = sessionStorage.getItem('sample-factory-continue-edit')
  if (!saved) return
  sessionStorage.removeItem('sample-factory-continue-edit')
  try {
    const source = JSON.parse(saved)
    const prepared = await prepareEditImage(source.url)
    const response = await fetch(prepared.url)
    if (!response.ok) throw new Error('无法读取历史样片')
    const blob = await response.blob()
    const file = new File([blob], `sample-${Date.now()}.${format.value}`, {type: blob.type || 'image/png'})
    Object.keys(materials.value).forEach((key) => {
      materials.value[key] = []
    })
    materials.value.reference = [markRaw({
      file,
      name: file.name,
      size: file.size,
      previewUrl: URL.createObjectURL(file)
    })]
    mode.value = 'image';
    imageOperation.value = 'edit';
    editParent.value = source;
    size.value = 'reference'
  } catch (exception) {
    error.value = exception.message || '无法读取历史样片'
  }
}

function resultPreviewIndex(index) {
  return results.value.slice(0, index).filter((item) => item.url).length
}

async function retry(index) {
  const item = results.value[index];
  if (!item?.requestSnapshot || running.value) return
  if (selected.value.has(index)) toggle(index)
  results.value[index] = {...item, loading: true}
  try {
    const response = await generateImage(item.requestSnapshot)
    const output = response.data?.[0];
    results.value[index] = {
      ...item,
      loading: false,
      imageLoading: Boolean(output?.url),
      url: output?.url || (output?.b64_json ? `data:image/png;base64,${output.b64_json}` : ''),
      id: output?.id || item.id,
      taskId: output?.taskId || item.taskId,
      parentResultId: output?.parentResultId || null,
      version: output?.version || 1,
      requestSnapshot: item.requestSnapshot
    }
  } catch (e) {
    results.value[index] = {...item, loading: false, error: e.message}
  }
}

async function exportSelected() {
  const urls = [...selected.value].sort((a, b) => a - b).map((index) => results.value[index]?.url).filter(Boolean)
  if (!urls.length || exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const exported = await exportImages(urls, format.value)
    ElMessage.success(`已导出 ${exported.count} 张图片到 ${exported.exportDir || '本地导出目录'}`)
  } catch (e) {
    error.value = e.message || '导出图片失败'
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  await refresh();
  await restoreHistoryEdit()
})

function onKeydown(event) {
  const tag = event.target?.tagName?.toLowerCase();
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || tag !== 'textarea')) {
    if (tag === 'input' && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    generate()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="v5-home-layout">
    <el-form label-position="top" class="workspace-form">
      <div class="grid">
        <aside class="task-setup" aria-label="本次生成任务">
          <section class="panel">
            <el-button class="rail-new-task" :icon="Plus" @click="clearCurrent">新建任务</el-button>
            <span class="eyebrow">01 / 生成模式</span>
            <h3>{{ isTextMode ? '文字生图' : '图生图' }}</h3>
            <div class="mode-toolbar">
              <div class="mode-switch" role="group" aria-label="生成模式">
                <el-button :type="isTextMode ? 'primary' : 'default'" @click="setMode('text')">文字生图</el-button>
                <el-button :type="!isTextMode ? 'primary' : 'default'" @click="setMode('image')">图生图</el-button>
              </div>
            </div>
            <p class="muted">{{
                isTextMode ? '无需上传素材，图像描述将直接发送给生成接口。' : '上传素材并指定角色，提示词仅补充生成意图。'
              }}</p>
            <div v-if="isTextMode" class="text-mode-empty">在下方提示词区域描述画面后即可开始生成。</div>
            <div v-if="!isTextMode" class="assets">
              <el-form-item label="处理方式" class="image-operation">
                <el-radio-group class="image-operation-options" :model-value="imageOperation"
                                @change="setImageOperation">
                  <el-radio-button label="batch">逐张批处理</el-radio-button>
                  <el-radio-button label="fusion">多图融合</el-radio-button>
                  <el-radio-button label="background">背景替换</el-radio-button>
                  <el-radio-button label="prop">道具替换</el-radio-button>
                  <el-radio-button label="edit">局部继续编辑</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <p class="operation-hint">{{
                  imageOperation === 'batch' ? '每张目标图独立生成。人物参考固定身份；上传背景和道具图后，会一并影响每张目标图的生成。' : imageOperation === 'fusion' ? '人物、主目标、背景和道具共同组成一个融合任务。' : imageOperation === 'background' ? '只使用主目标图和背景参考图，保留前景主体。' : imageOperation === 'prop' ? '只使用主目标图和道具参考图，指定画面中要替换的对象。' : '从结果中选择一张样片作为基础图，只描述需要修改的局部内容。'
                }}</p>
              <div v-for="item in activeMaterialTypes" :key="item.key" class="material-box"
                   :class="{ 'is-primary': item.required, 'has-files': materials[item.key].length }">
                <div class="material-heading">
                  <div>
                    <span class="material-step">{{ item.step }}</span>
                    <b>{{ item.label }}</b>
                  </div>
                  <span class="material-count">{{ materials[item.key].length }}<i>/ {{ item.limit }}</i></span>
                </div>
                <p>{{ item.hint }}</p>
                <el-upload class="material-upload" drag action="#" :auto-upload="false" :show-file-list="false" multiple
                           accept="image/*"
                           @change="addFiles(item.key, $event)">
                  <div class="drop-zone">
                    <ImagePlus :size="15" aria-hidden="true"/>
                    <span>{{ materials[item.key].length ? '继续添加图片' : '拖入图片，或点击选择' }}</span>
                  </div>
                </el-upload>
                <div class="thumbs">
                  <div v-for="(file,index) in materials[item.key]" :key="file.uid || file.name + index" class="thumb">
                    <el-image :src="file.previewUrl" fit="cover"
                              :initial-index="index"
                              preview-teleported
                              hide-on-click-modal
                              :preview-src-list="materialPreviewUrls[item.key]"/>
                    <button type="button" class="thumb-delete" title="删除图片" @click="removeFile(item.key,index)">
                      <X :size="11"/>
                    </button>
                  </div>
                </div>
                <small class="material-footer">
                  <span v-if="item.required && !materials[item.key].length">生成前需添加人物素材</span>
                  <span v-else>{{ materials[item.key].length ? '素材已就绪' : '可选素材' }}</span>
                  <span v-if="materials[item.key].length">{{ materials[item.key].length }} 张待使用</span>
                </small>
              </div>
              <el-form-item v-if="imageOperation === 'prop'" label="要替换的画面对象" class="replace-object">
                <el-input v-model="replaceObject" placeholder="例如：桌上的花瓶"/>
              </el-form-item>
            </div>
            <div v-else class="text-mode-empty">选择右侧模板、模型和规格后，填写图像描述即可开始生成。</div>
          </section>
          <section class="panel config-panel composer-panel">
            <div class="composer-heading">
              <h3>提示词</h3>
            </div>
            <div class="quick-controls" aria-label="常用生成设置">
              <el-form-item class="quick-control quick-model" label="模型">
                <el-select v-model="model" class="studio-select" filterable placeholder="选择模型" popper-class="studio-select-popper" clearable>
                  <el-option v-for="(item, index) in models" :key="item.id" :label="item.id" :value="item.id">
                    <div class="select-option"><span class="select-index">{{ String(index + 1).padStart(2, '0') }}</span><span><b>{{ item.id }}</b><small>{{ index === 0 ? '主力生成模型' : '备用生成模型' }}</small></span></div>
                  </el-option>
                </el-select>
              </el-form-item>
              <el-button class="quick-refresh" text :icon="Refresh" title="刷新模型" aria-label="刷新模型" @click="refresh" :disabled="running"/>
              <el-form-item class="quick-control quick-preset" label="预设">
                <el-select v-model="presetId" class="studio-select" filterable placeholder="未选择预设" popper-class="studio-select-popper">
                  <el-option v-for="(item, index) in availableTemplates" :key="item.id" :label="item.name" :value="item.id">
                    <div class="select-option"><span class="select-index">{{ String(index + 1).padStart(2, '0') }}</span><span><b>{{ item.name }}</b></span></div>
                  </el-option>
                </el-select>
              </el-form-item>
              <el-form-item class="quick-control quick-size" label="尺寸">
                <el-select v-model="size" class="studio-select" popper-class="studio-select-popper">
                  <el-option v-if="!isTextMode" label="跟随目标图" value="reference"/><el-option label="2048 × 2048" value="2048x2048"/><el-option label="2560 × 1440" value="2560x1440"/><el-option label="1440 × 2560" value="1440x2560"/><el-option label="3024 × 1296" value="3024x1296"/><el-option label="自定义尺寸" value="custom"/>
                </el-select>
              </el-form-item>
              <el-form-item class="quick-control quick-count" label="数量"><el-input-number v-model="count" :min="1" :max="10" controls-position="right"/></el-form-item>
              <el-form-item class="quick-control quick-format" label="格式">
                <el-select v-model="format" class="studio-select" popper-class="studio-select-popper"><el-option label="PNG" value="png"/><el-option label="JPG" value="jpg"/><el-option label="WebP" value="webp"/></el-select>
              </el-form-item>
              <el-form-item class="quick-control quick-resolution" label="分辨率">
                <el-select v-model="resolution" class="studio-select" popper-class="studio-select-popper"><el-option label="2K" value="2K"/><el-option label="4K" value="4K"/></el-select>
              </el-form-item>
              <div v-if="size === 'custom'" class="quick-custom-size"><el-input-number v-model="customWidth" :min="256" :max="4096" :step="8"/><span>×</span><el-input-number v-model="customHeight" :min="256" :max="4096" :step="8"/></div>
            </div>
            <div class="prompt-surface">
              <el-form-item class="composer-prompt">
                <el-input v-model="prompt" type="textarea" :rows="3"
                          :placeholder="isTextMode ? '描述想生成的画面、主体、风格和光线' : (imageOperation === 'edit' ? '例如：只把人物外套改成深蓝色，其余画面保持不变' : '仅填写本次额外要求')"/>
              </el-form-item>
              <div class="task-action-bar">
                <el-button class="clear-button" @click="clearCurrent">清空当前</el-button>
                <el-button type="primary" :icon="VideoPlay" @click="generate">{{ running ? '追加生成' : '开始生成' }}</el-button>
                <button v-if="running" type="button" class="stop-generation-button" @click="stop"><el-icon><VideoPause/></el-icon>停止生成</button>
              </div>
            </div>
            <section class="config-summary" aria-live="polite">
              <span>预计样片</span>
              <b>{{ totalExpected }}</b>
              <small>{{ expectedFormula }}</small>
              <small>{{ sizeSummary }}</small>
              <em :class="{ 'is-ready': expectedState === '可以生成' }">{{ expectedState }}</em>
            </section>
          </section>
        </aside>
      </div>
    </el-form>
    <section class="panel queue">
      <div class="queue-head">
        <div><span class="eyebrow">03 / 结果画廊</span>
          <h3>样片预览</h3></div>
        <div v-if="running || completedCount" class="generation-status"><span>{{
            running ? (queuedCount ? `正在生成，后面还有 ${queuedCount} 组等待处理` : '正在调用接口生成') : '生成完成'
          }}</span><b>{{ completedCount }} / {{ progressTotal }}</b>
          <div class="progress-track"><i :style="{width: progressPercent + '%'}"></i></div>
        </div>
        <div class="queue-actions">
          <el-button :disabled="!results.length || running" @click="toggleSelectAll">
            {{ allResultsSelected ? '取消全选' : '全选' }} ({{ results.length }})
          </el-button>
          <el-button :icon="Delete" type="danger" plain :disabled="!selected.size || running"
                     @click="removeSelected">删除已选 ({{ selected.size }})</el-button>
          <el-button :icon="Download" :loading="exporting" :disabled="!selected.size || exporting || preparingEdit"
                     @click="exportSelected">导出已选 ({{ selected.size }})</el-button>
          <el-button :icon="PenLine" :loading="preparingEdit" :disabled="selected.size !== 1 || running || preparingEdit"
                     @click="continueEdit">{{ preparingEdit ? '准备编辑图' : '继续编辑' }}</el-button>
        </div>
      </div>
      <el-alert v-if="error" :title="error" type="error" show-icon/>
      <div v-if="!results.length" class="empty">暂无生成结果</div>
      <div v-else class="gallery">
        <div v-for="(item,index) in results" :key="item.id || index" class="result-card"
             :class="{ selected: selected.has(index) }">
          <div v-if="item.loading" class="loading-placeholder">
            <span>{{ item.status === 'generating' ? '正在加载图片...' : '等待生成' }}</span>
            <b>样片 {{ index + 1 }}</b>
            <i v-if="item.status === 'generating'"/>
            <small>{{ completedCount }} / {{ progressTotal }}</small>
          </div>
          <div v-else-if="item.error" class="result-error">
            <strong>生成失败</strong>
            <span>{{ item.error }}</span>
            <el-button v-if="item.task" size="small" :icon="Refresh" @click="retry(index)">重试</el-button>
          </div>
          <template v-else-if="item.url">
            <el-image :src="item.url" fit="cover"
                      :class="{ 'is-image-loading': item.imageLoading }"
                      @load="item.imageLoading = false"
                      @error="item.imageLoading = false"
                      :initial-index="resultPreviewIndex(index)"
                      preview-teleported
                      hide-on-click-modal
                      :preview-src-list="results.filter((item) => item.url).map((item) => item.url)"/>
            <span class="result-label">{{ item.label }} · V{{ item.version || 1 }}<small
                v-if="item.parentResultId">续作</small></span>
            <el-button v-if="item.task" size="small" :icon="Refresh" @click="retry(index)">再次生成</el-button>
          </template>
          <div v-else class="result-error">
            <strong>未生成图片</strong>
            <span>接口没有返回可预览的图片</span>
            <el-button v-if="item.task" size="small" :icon="Refresh" @click="retry(index)">重试</el-button>
          </div>
          <span v-if="item.url && item.imageLoading" class="image-loading-indicator">正在加载图片...</span>
          <el-checkbox :model-value="selected.has(index)" class="result-check"
                       :aria-label="`选择样片 ${index + 1}`" @click.stop @change="toggle(index)"/>
        </div>
      </div>
    </section>
  </div>
</template>
