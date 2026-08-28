<script setup>
import {ref, computed, onMounted, onBeforeUnmount, onActivated, markRaw, watch} from 'vue'
import {Delete, Upload, Refresh, VideoPlay, Download, SwitchButton} from '@element-plus/icons-vue'
import {ElMessage} from 'element-plus'
import {X, Plus, ImagePlus, PenLine} from 'lucide-vue-next'
import {
  getSettings,
  getModels,
  getPromptTemplates,
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
const configLoading = ref(false)
const modelLoadError = ref('')
const templateLoadError = ref('')
const activeWorkspaceName = ref('')
const model = ref('');
const modelMode = ref('balanced');
const presetId = ref('');
const prompt = ref('');
const count = ref(1);
const resolution = ref('2K');
const format = ref('png');
const size = ref('1024x1024');
const customWidth = ref(null);
const customHeight = ref(null);
const running = ref(false);
const completedCount = ref(0);
const generationTotal = ref(0);
const error = ref('');
const generationControllers = new Map()
const activeGenerationWorks = new Set()
const queuedCount = ref(0)
const preview = ref('')
const materials = ref({person: [], pose: [], prop: [], scene: [], reference: [], batchReference: [], editReference: []})
const mode = ref('text')
const isTextMode = computed(() => mode.value === 'text')
const imageOperation = ref('batch')
const visibleImageOperations = ['batch', 'three-view', 'edit']
const replaceObject = ref('')
const editParent = ref(null)
const promptHeight = ref(112)
const promptResizeActive = ref(false)
let promptResizeCleanup = null
const leftRailWidth = ref(286)
const railResizeActive = ref(false)
let railResizeCleanup = null
const HOME_MEMORY_DB = 'sample-factory-home-memory'
const HOME_MEMORY_STORE = 'workspace'
const HOME_MEMORY_KEY = 'home'
const HOME_MEMORY_VERSION = 1
let restoringHomeMemory = true
let persistHomeMemoryTimer = 0
let configRequestId = 0
let templateRequestId = 0

function showMessage(type, message) {
  if (!message) return
  ElMessage({
    type,
    message,
    duration: type === 'error' ? 5000 : 3500,
    showClose: true,
    grouping: true
  })
}

watch(error, (message) => {
  if (!message) return
  showMessage('error', message)
  error.value = ''
})

function openHomeMemoryDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HOME_MEMORY_DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(HOME_MEMORY_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readHomeMemory() {
  const db = await openHomeMemoryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HOME_MEMORY_STORE, 'readonly')
    const request = transaction.objectStore(HOME_MEMORY_STORE).get(HOME_MEMORY_KEY)
    request.onsuccess = () => resolve(request.result || null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => db.close()
  })
}

async function writeHomeMemory(value) {
  const db = await openHomeMemoryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HOME_MEMORY_STORE, 'readwrite')
    transaction.objectStore(HOME_MEMORY_STORE).put(value, HOME_MEMORY_KEY)
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

async function clearHomeMemory() {
  const db = await openHomeMemoryDb()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HOME_MEMORY_STORE, 'readwrite')
    transaction.objectStore(HOME_MEMORY_STORE).delete(HOME_MEMORY_KEY)
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file)
  })
}

async function getRequestSize(task, requestConfig) {
  if (requestConfig.size === 'custom') {
    const width = Number(requestConfig.customWidth)
    const height = Number(requestConfig.customHeight)
    const custom = `${width}x${height}`
    return custom
  }
    return modelSupportsSize(requestConfig.size) ? requestConfig.size : '1024x1024';
}

function resolutionForSize(value) {
  if (value === '1080x1920') return '1K'
  if (value === '2160x3240') return '2K'
  if (value === '2160x3840') return '4K'
  // Custom dimensions already fully specify the output size. Sending a
  // second, fixed resolution can make providers reject the request.
  return ''
}

const materialLabels = {
  person: '人物',
  prop: '道具',
  reference: '目标/构图',
  pose: '动作',
  scene: '场景',
  batchReference: '画面参考图',
  editReference: '编辑参考图'
}
const results = ref([]);
const selected = ref(new Set())
const exporting = ref(false)
const preparingEdit = ref(false)
const allResultsSelected = computed(() => results.value.length > 0 && selected.value.size === results.value.length)
const selectedLoadingCount = computed(() => [...selected.value].filter((index) => results.value[index]?.loading).length)
const selectedRemovableCount = computed(() => [...selected.value].filter((index) => {
  const item = results.value[index]
  return item && (!running.value || !item.loading)
}).length)

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
  if (size.value === 'custom') return `${customWidth.value} x ${customHeight.value}`
  return size.value
})
const expectedFormula = computed(() => {
  const copies = Math.max(1, Number(count.value || 1))
  if (isTextMode.value) return `1 个文字任务 x ${copies}`
  if (imageOperation.value === 'batch') return `${materials.value.reference.length} 张目标图 x ${copies}`
  if (imageOperation.value === 'three-view') return `${materials.value.reference.length} 张身份图 x ${copies}`
  return `1 个${operationLabel()}任务 x ${copies}`
})
const expectedState = computed(() => {
  if (isTextMode.value) return prompt.value.trim() ? '可以生成' : '请填写图像描述'
  return imageValidationError() || '可以生成'
})
const availableTemplates = computed(() => {
  return presets.value
})
const preset = computed(() => availableTemplates.value.find((item) => item.id === presetId.value))
const configStatusTitle = computed(() => {
  if (configLoading.value) return activeWorkspaceName.value ? `正在加载 ${activeWorkspaceName.value} 的模型与提示词预设...` : '正在加载当前工作台的模型与提示词预设...'
  if (modelLoadError.value || templateLoadError.value) return [modelLoadError.value, templateLoadError.value].filter(Boolean).join('；')
  if (!models.value.length) return '当前工作台暂无可用模型，请手动刷新或前往 API 管理检查配置。'
  return ''
})
const configStatusType = computed(() => configLoading.value ? 'info' : 'warning')
const materialTypes = [
  {key: 'person', label: '人物参考', step: '可选', hint: '用于固定人物身份、脸部与服装', limit: 3},
  {key: 'reference', label: '目标 / 构图图', step: '任务', hint: '每张图片单独执行一次处理，可叠加背景和道具素材', limit: 30},
  {key: 'prop', label: '道具参考', step: '可选', hint: '用于影响每张目标图中的道具内容', limit: 30}
]

function normalizeConfigSelection() {
  if (models.value.length && !models.value.some((item) => item.id === model.value)) model.value = models.value[0]?.id || ''
  if (!models.value.length) model.value = ''
  if (!availableTemplates.value.some((item) => item.id === presetId.value)) presetId.value = ''
}
materialTypes.push({key: 'scene', label: '背景参考', step: '可选', hint: '用于影响每张目标图的背景与环境', limit: 30})
materialTypes.push({key: 'pose', label: '动作模仿', step: '可选', hint: '上传后优先模仿动作与身体朝向；未上传则沿用目标图动作', limit: 1})
materialTypes.push({key: 'batchReference', label: '画面参考图', step: '可选', hint: '用于统一参考色调、道具或画面氛围；请在提示词中说明要借用什么', limit: 1})
materialTypes.push({key: 'editReference', label: '编辑参考图', step: '可选', hint: '用于参考指定道具、材质或画面风格；请在提示词中说明要借用什么', limit: 1})
const activeMaterialTypes = computed(() => {
  const keys = {
    batch: ['person', 'reference', 'batchReference', 'pose', 'scene', 'prop'],
    'three-view': ['reference'],
    fusion: ['person', 'reference', 'scene', 'prop'],
    background: ['reference', 'scene'],
    prop: ['reference', 'prop'],
    edit: ['reference', 'editReference']
  }[imageOperation.value] || []
  return materialTypes.filter((item) => keys.includes(item.key))
})

const sizeOptions = [
  {label: '1K（1080x1920）', value: '1080x1920'},
  {label: '2K（2160x3240）', value: '2160x3240'},
  {label: '4K（2160x3840）', value: '2160x3840'},
  {label: '自定义尺寸', value: 'custom'}
]
const selectedModel = computed(() => models.value.find((item) => item.id === model.value) || null)
function modelSupportsSize(value) {
  if (value === 'custom') return true
  const supported = selectedModel.value?.supportedSizes
  return !Array.isArray(supported) || supported.length === 0 || supported.includes(value)
}
function sizeDisabled(value) {
  return !modelSupportsSize(value)
}

watch(model, () => {
  if (!modelSupportsSize(size.value)) size.value = '1024x1024'
})

function rawFile(value) {
  return value?.raw instanceof File ? value.raw : value instanceof File ? value : value?.file instanceof File ? value.file : null
}

function materialMemoryItem(item) {
  const file = rawFile(item)
  if (!file) return null
  return {
    file,
    name: item.name || file.name,
    size: item.size || file.size,
    type: file.type,
    lastModified: file.lastModified
  }
}

function restoreMaterialItem(item) {
  const file = item?.file instanceof File ? item.file : null
  if (!file) return null
  return markRaw({
    file,
    name: item.name || file.name,
    size: item.size || file.size,
    previewUrl: URL.createObjectURL(file)
  })
}

function resultMemoryItem(item) {
  return {
    id: item.id,
    loading: false,
    status: item.loading ? 'stopped' : item.status,
    error: item.error || '',
    url: item.url || '',
    label: item.label || '样片',
    taskId: item.taskId || null,
    parentResultId: item.parentResultId || null,
    version: item.version || 1,
    requestSnapshot: item.requestSnapshot || null
  }
}

function restoreResultItem(item) {
  return {
    ...item,
    loading: false,
    imageLoading: Boolean(item?.url),
    task: item?.requestSnapshot ? {label: item.label || '样片', type: item.requestSnapshot.operation || item.requestSnapshot.mode || 'text'} : null
  }
}

function makeHomeMemorySnapshot() {
  return {
    version: HOME_MEMORY_VERSION,
    savedAt: new Date().toISOString(),
    form: {
      model: model.value,
      modelMode: modelMode.value,
      presetId: presetId.value,
      prompt: prompt.value,
      count: count.value,
      resolution: resolution.value,
      format: format.value,
      size: size.value,
      customWidth: customWidth.value,
      customHeight: customHeight.value,
      mode: mode.value,
      imageOperation: imageOperation.value,
      replaceObject: replaceObject.value,
      editParent: editParent.value
    },
    materials: Object.fromEntries(
      Object.entries(materials.value).map(([key, items]) => [key, items.map(materialMemoryItem).filter(Boolean)])
    ),
    results: results.value.map(resultMemoryItem)
  }
}

async function restoreHomeMemory() {
  try {
    const saved = await readHomeMemory()
    if (!saved || saved.version !== HOME_MEMORY_VERSION) return
    const form = saved.form || {}
    model.value = form.model || model.value
    modelMode.value = form.modelMode || modelMode.value
    presetId.value = form.presetId || ''
    prompt.value = form.prompt || ''
    count.value = Number(form.count || 1)
    resolution.value = form.resolution || resolution.value
    format.value = form.format || format.value
    size.value = form.size || size.value
    customWidth.value = form.customWidth ? Number(form.customWidth) : null
    customHeight.value = form.customHeight ? Number(form.customHeight) : null
    mode.value = form.mode || mode.value
    imageOperation.value = visibleImageOperations.includes(form.imageOperation) ? form.imageOperation : imageOperation.value
    replaceObject.value = form.replaceObject || ''
    editParent.value = form.editParent || null
    Object.keys(materials.value).forEach((key) => {
      materials.value[key] = (saved.materials?.[key] || []).map(restoreMaterialItem).filter(Boolean)
    })
    results.value = (saved.results || []).map(restoreResultItem)
    selected.value = new Set()
  } catch (exception) {
    console.warn('home memory restore failed', exception)
  }
}

function scheduleHomeMemoryPersist() {
  if (restoringHomeMemory) return
  window.clearTimeout(persistHomeMemoryTimer)
  persistHomeMemoryTimer = window.setTimeout(() => {
    writeHomeMemory(makeHomeMemorySnapshot()).catch((exception) => console.warn('home memory save failed', exception))
  }, 250)
}

function referenceRole(key) {
  if (key === 'reference') return 'target_reference'
  if (key === 'batchReference') return 'visual_reference'
  if (key === 'editReference') return 'edit_reference'
  return `${key}_reference`
}

function referencePromptLabel(key) {
  return ({
    person: '人物参考图',
    reference: '目标图/构图图',
    prop: '道具图',
    scene: '场景参考图',
    pose: '动作参考图',
    batchReference: '画面参考图',
    editReference: '编辑参考图'
  })[key] || '参考图'
}

async function buildLabeledReferences(task, materialSet = materials.value) {
  if (task?.type === 'text') return []
  const labeled = []
  const materialOrder = task.materialKeys || ['person', 'reference', 'batchReference', 'pose', 'prop', 'scene', 'editReference']
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
  const limit = key === 'person' ? 3 : ['pose', 'batchReference', 'editReference'].includes(key) ? 1 : 30;
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

async function refresh(options = {}) {
  const requestId = ++configRequestId
  configLoading.value = true
  modelLoadError.value = ''
  templateLoadError.value = ''
  if (options.clearCurrent !== false) {
    models.value = []
    model.value = ''
    presets.value = []
    presetId.value = ''
  }
  try {
    const settings = await getSettings().catch(() => null)
    if (requestId !== configRequestId) return
    const activeApi = settings?.apis?.find((item) => item.id === settings.activeApiId)
    activeWorkspaceName.value = activeApi?.name || ''
    const modelsRequest = getModels()
    const templatesVersion = ++templateRequestId
    const templatesRequest = getPromptTemplates()
    const userTemplatesResult = await Promise.allSettled([templatesRequest]).then(([result]) => result)
    if (requestId !== configRequestId) return
    if (userTemplatesResult.status === 'fulfilled' && templatesVersion === templateRequestId) {
      presets.value = userTemplatesResult.value || []
    } else if (templatesVersion === templateRequestId) {
      templateLoadError.value = userTemplatesResult.reason?.message || '提示词预设加载失败'
      showMessage('error', templateLoadError.value)
    }
    normalizeConfigSelection()
    const modelsResult = await Promise.allSettled([modelsRequest]).then(([result]) => result)
    if (requestId !== configRequestId) return
    if (modelsResult.status === 'fulfilled') {
      models.value = modelsResult.value || []
      const preferredModel = activeApi?.model && models.value.some((item) => item.id === activeApi.model) ? activeApi.model : ''
      model.value = preferredModel || (models.value.some((item) => item.id === model.value) ? model.value : models.value[0]?.id || '')
      if (!models.value.length) {
        modelLoadError.value = '当前工作台没有返回模型列表'
        showMessage('warning', modelLoadError.value)
      }
    } else {
      modelLoadError.value = modelsResult.reason?.message || '模型配置加载失败'
      showMessage('error', modelLoadError.value)
    }
    normalizeConfigSelection()
  } finally {
    if (requestId === configRequestId) configLoading.value = false
  }
}

async function startNewTask() {
  activeGenerationWorks.forEach((work) => work.controller?.abort())
  generationControllers.forEach((controller) => controller.abort())
  generationControllers.clear()
  activeGenerationWorks.clear()
  running.value = false
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
  size.value = '1024x1024';
  customWidth.value = null;
  customHeight.value = null;
  error.value = '';
  completedCount.value = 0;
  generationTotal.value = 0;
  queuedCount.value = 0;
  await clearHomeMemory().catch((exception) => console.warn('home memory clear failed', exception))
}

function clearCurrent() {
  Object.keys(materials.value).forEach((key) => {
    materials.value[key] = []
  });
  selected.value = new Set();
  prompt.value = '';
  replaceObject.value = '';
  editParent.value = null;
  presetId.value = '';
  count.value = 1;
  error.value = '';
  completedCount.value = 0;
}

function setMode(nextMode) {
  if (mode.value === nextMode) return
  mode.value = nextMode
  error.value = ''
  completedCount.value = 0
  presetId.value = ''
}

async function refreshPromptTemplates() {
  const requestId = ++templateRequestId
  templateLoadError.value = ''
  try {
    const nextTemplates = await getPromptTemplates()
    if (requestId !== templateRequestId) return
    presets.value = nextTemplates || []
    normalizeConfigSelection()
  } catch (error) {
    if (requestId !== templateRequestId) return
    templateLoadError.value = error?.message || '提示词预设加载失败'
    showMessage('error', templateLoadError.value)
  }
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
    edit: '局部继续编辑',
    'three-view': '三视图'
  })[operation] || '图生图'
}

function buildImageTasks() {
  const target = materials.value.reference[0]
  if (imageOperation.value === 'batch') {
    return materials.value.reference.map((item, index) => ({
      // The target must be the first physical image: several image models use
      // the first input as the editing canvas despite the textual role labels.
      item, type: 'reference', label: `逐张处理 ${index + 1}`, materialKeys: ['reference', 'batchReference', 'person', 'pose', 'scene', 'prop']
    }))
  }
  if (imageOperation.value === 'three-view') {
    return materials.value.reference.map((item, index) => ({
      item, type: 'three-view', label: `三视图 ${index + 1}`, materialKeys: ['reference']
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
    return [{item: target, type: 'local-edit', label: '局部继续编辑', materialKeys: ['reference', 'editReference']}]
  }
  return [{item: target, type: 'prop-replace', label: '道具替换', materialKeys: ['reference', 'prop']}]
}

function imageValidationError() {
  if (!materials.value.reference.length) return `${operationLabel()}需要至少一张上传图片`
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
  const manifest = ['提示词可直接使用“人物参考图”“目标图/构图图”“道具图”“场景参考图”“动作参考图”“画面参考图”或“编辑参考图”指代对应类别，无需使用图片序号。', '本次请求会同时发送以上全部参考图；本次主参考图是“' + (primary?.promptLabel || '无') + '”。当规则提到目标图、构图图或主参考图时，均以该图片为准。', ...labeled.map((item, index) => `图片${index + 1}：${item.promptLabel}${item.primary ? '（本次主参考图）' : ''}（${item.role}）`)].join('\n');
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
                              : taskType === 'three-view'
                                  ? '以上传图片作为唯一身份参考，生成干净的三视图：同一人物的全身正面、45度三分之二侧脸和90度标准侧脸直接并排展示。严格保持原图的人脸特征、脸型、骨相、发型、服装、配饰和头饰，使用纯白无缝背景、自然彩色和中性影棚白平衡，不添加文字、边框或界面元素。'
                                  : '只根据补充提示词为人物参考中的同一人物创建一个新变化。';
  const batchMaterialRule = taskType === 'reference' ? [
    labeled.some((item) => item.role === 'pose_reference')
      ? '动作模仿图是本次动作的唯一优先来源：严格模仿其中人物的姿势、肢体关系和身体朝向，但不得带入动作图人物的身份、脸部、服装、道具或背景；此时不要以目标图中的原动作覆盖动作模仿图。'
      : '未上传动作模仿图时，保持并参考目标图中的原有动作、肢体关系和身体朝向。',
    labeled.some((item) => item.role === 'scene_reference') && '背景参考图是必须使用的视觉来源：将背景图中可辨识的场景、地点、室内外环境、主要背景物体、色调和氛围融入主目标图背景，不得忽略或以无关背景替代。',
    labeled.some((item) => item.role === 'prop_reference') && '道具图是必须使用的视觉来源：在主目标图中清晰呈现道具图里的主要道具，保留其可辨识的外形、材质、颜色和关键细节，并使其与人物或画面自然接触；不得省略、替换为其他道具或只保留相似概念。',
    labeled.some((item) => item.role === 'visual_reference') && '画面参考图不是另一张待处理的目标图，也不得整张覆盖或合成到当前目标图。它只提供用户在补充提示词中明确指定的视觉特征，例如色调、光线、氛围、道具或材质。每一张目标图都应独立应用这些明确要求，同时保持各自未指定的主体、构图、位置、透视和内容不变；未明确要求时不得擅自借用参考图的其他主体或背景。'
  ].filter(Boolean).join('\n') : '';
  const editReferenceRule = taskType === 'local-edit' && labeled.some((item) => item.role === 'edit_reference')
      ? '编辑参考图不是第二张待编辑画布，也不得整张覆盖或合成到主参考图。它只提供用户在补充提示词中明确指定的内容或视觉特征，例如某个道具、花材、材质、色调、光线或氛围。只借用与明确要求有关的特征；未明确要求时不得使用它。若用户明确要求色调或光线调整，可在完成该要求所需范围内调整全图，同时保持主体、构图、空间关系和未指定内容不变。'
      : '';
  const rule = [configuredRule, defaultRule, batchMaterialRule, editReferenceRule].filter(Boolean).join('\n\n');
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
  const normalizedWidth = Number(customWidth.value)
  const normalizedHeight = Number(customHeight.value)
  if (size.value === 'custom' && (!Number.isInteger(normalizedWidth) || !Number.isInteger(normalizedHeight))) {
    error.value = '请选择自定义尺寸后填写宽度和高度';
    return null
  }
  if (size.value === 'custom' && (normalizedWidth < 256 || normalizedHeight < 256 || normalizedWidth > 4096 || normalizedHeight > 4096)) {
    error.value = '自定义尺寸不能超过 4K（4096 像素）';
    return null
  }
  if (size.value === 'custom' && (normalizedWidth % 16 !== 0 || normalizedHeight % 16 !== 0)) {
    error.value = '自定义尺寸的宽度和高度必须都是 16 的倍数';
    return null
  }
  if (size.value !== 'custom' && !modelSupportsSize(size.value)) {
    error.value = `模型 ${model.value} 不支持 ${size.value}，请改用可用尺寸`;
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
    customWidth: size.value === 'custom' ? normalizedWidth : null,
    customHeight: size.value === 'custom' ? normalizedHeight : null,
    replaceObject: replaceObject.value,
    format: format.value,
    resolution: resolutionForSize(size.value)
  }
  const materialSnapshot = Object.fromEntries(
    Object.entries(materials.value).map(([key, items]) => [key, [...items]])
  )
  const jobs = tasks.flatMap((task) =>
      Array.from({length: count.value}, (_, copyIndex) => ({task, copyIndex}))
  );
  if (!running.value) {
    completedCount.value = 0
    generationTotal.value = 0
  }
  generationTotal.value += jobs.length
  const resultStart = results.value.length
  results.value.push(...jobs.map(({task}, index) => ({
    id: `result-${Date.now()}-${resultStart + index}`,
    loading: true,
    status: 'generating',
    label: task.label,
    task
  })));
  return {tasks, jobs, resultStart, requestConfig, materialSnapshot, copies: Number(count.value)}
}

async function runGeneration(work) {
  const workController = new AbortController()
  work.controller = workController
  activeGenerationWorks.add(work)
  running.value = true
  try {
    const selectedTemplate = availableTemplates.value.find((item) => item.id === work.requestConfig.presetId)
    const preparedTasks = await Promise.all(work.tasks.map(async (task) => ({
      task,
      labeled: await buildLabeledReferences(task, work.materialSnapshot),
      requestSize: await getRequestSize(task, work.requestConfig)
    })))
    if (workController.signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const preparedByTask = new Map(preparedTasks.map((item) => [item.task, item]))

    const jobs = work.jobs.map(async ({task}, jobIndex) => {
      const prepared = preparedByTask.get(task)
      const {labeled} = prepared
      const resultIndex = work.resultStart + jobIndex
      const resultId = results.value[resultIndex]?.id
      const currentResultIndex = () => results.value.findIndex((item) => item?.id === resultId)
      const taskId = crypto.randomUUID()
      const controller = new AbortController()
      generationControllers.set(taskId, controller)
      const abortHandler = () => controller.abort()
      workController.signal.addEventListener('abort', abortHandler, {once: true})
      const requestSnapshot = {
          model: work.requestConfig.model,
          prompt: buildMaterialPrompt(labeled, task.type, task.label, work.requestConfig.replaceObject, selectedTemplate?.systemPrompt || ''),
          extraPrompt: work.requestConfig.prompt,
          presetId: work.requestConfig.presetId,
          mode: work.requestConfig.mode,
          images: labeled.map((item) => item.data),
          materials: labeled,
          n: 1,
          size: prepared.requestSize,
          quality: work.requestConfig.quality,
          format: work.requestConfig.format,
          resolution: work.requestConfig.resolution,
          mask: '',
          taskId,
          parentResultId: task.type === 'local-edit' ? editParent.value?.id || null : null,
          version: task.type === 'local-edit' ? Number(editParent.value?.version || 0) + 1 : 1,
          operation: task.type
      }
      const startedIndex = currentResultIndex()
      if (startedIndex >= 0) results.value[startedIndex] = {
        ...results.value[startedIndex],
        status: 'generating',
        taskId,
        requestSnapshot
      }
      try {
        const response = await generateImage(requestSnapshot, {signal: controller.signal});
        const output = response.data?.[0];
        const finishedIndex = currentResultIndex()
        if (finishedIndex >= 0) results.value[finishedIndex] = {
          id: results.value[finishedIndex]?.id || `result-${Date.now()}-${resultIndex}`,
          loading: false,
          imageLoading: Boolean(output?.url),
          url: output?.url || (output?.b64_json ? `data:image/png;base64,${output.b64_json}` : ''),
          label: task.label,
          task,
          id: output?.id || results.value[finishedIndex]?.id,
          taskId: output?.taskId || taskId,
          parentResultId: output?.parentResultId || null,
          version: output?.version || 1,
          requestSnapshot
        };
      } catch (e) {
        if (e.name !== 'AbortError' && !controller.signal.aborted && !workController.signal.aborted) {
          error.value = e.message || '生成失败'
          const failedIndex = currentResultIndex()
          if (failedIndex >= 0) results.value[failedIndex] = {...results.value[failedIndex], loading: false, status: e.details?.generationAcceptedUnknown ? 'uncertain' : 'failed', uncertain: Boolean(e.details?.generationAcceptedUnknown), error: e.message || '生成失败'}
        }
      } finally {
        completedCount.value += 1
        generationControllers.delete(taskId)
        workController.signal.removeEventListener('abort', abortHandler)
      }
    })
    await Promise.all(jobs)
  } catch (e) {
    if (e.name !== 'AbortError') error.value = e.message;
    results.value.slice(work.resultStart, work.resultStart + work.jobs.length).forEach((item, offset) => {
      if (item?.loading) results.value[work.resultStart + offset] = {...item, loading: false, status: e.details?.generationAcceptedUnknown ? 'uncertain' : 'failed', uncertain: Boolean(e.details?.generationAcceptedUnknown), error: e.message || '生成失败'}
    })
  } finally {
    work.controller = null
    activeGenerationWorks.delete(work)
    if (!activeGenerationWorks.size) {
      running.value = false
      queuedCount.value = 0
    }
  }
}

async function generate() {
  const work = createGenerationWork()
  if (!work) return
  running.value = true
  queuedCount.value = 0
  void runGeneration(work)
}

async function stop() {
  const taskIds = [...generationControllers.keys()]
  activeGenerationWorks.forEach((work) => work.controller?.abort())
  generationControllers.forEach((controller) => controller.abort())
  generationControllers.clear()
  activeGenerationWorks.clear()
  queuedCount.value = 0
  running.value = false;
  results.value = results.value.map((item) => item.loading
    ? {...item, loading: false, status: 'stopped', error: ''}
    : item)
  error.value = ''
  void Promise.all(taskIds.map((taskId) => cancelGeneration(taskId).catch(() => null)))
}

async function stopOne(index) {
  const item = results.value[index]
  const taskId = item?.taskId || item?.requestSnapshot?.taskId
  if (!item?.loading || !taskId) return
  generationControllers.get(taskId)?.abort()
  generationControllers.delete(taskId)
  results.value[index] = {
    ...item,
    loading: false,
    status: 'stopped',
    error: ''
  }
  void cancelGeneration(taskId).catch(() => null)
}

async function stopSelected() {
  const loadingIndexes = [...selected.value].filter((index) => results.value[index]?.loading)
  if (!loadingIndexes.length) return
  await Promise.all(loadingIndexes.map((index) => stopOne(index)))
  selected.value = new Set()
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
  if (!selectedRemovableCount.value) return
  // Keep in-flight cards in place while generation is active. Jobs address
  // their original slots, so removing them here would shift later updates.
  const selectedIndexes = new Set([...selected.value].filter((index) => {
    const item = results.value[index]
    return item && (!running.value || !item.loading)
  }))
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
    size.value = '1024x1024'
    presetId.value = ''
    selected.value = new Set()
    showMessage('success', '已将选中样片设为编辑基础图')
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
    size.value = '1024x1024'
  } catch (exception) {
    error.value = exception.message || '无法读取历史样片'
  }
}

function resultPreviewIndex(index) {
  return results.value.slice(0, index).filter((item) => item.url).length
}

async function retry(index) {
  const item = results.value[index];
  if (!item?.requestSnapshot || item.loading) return
  if (selected.value.has(index)) toggle(index)
  const taskId = crypto.randomUUID()
  const controller = new AbortController()
  const requestSnapshot = {...item.requestSnapshot, taskId}
  generationControllers.set(taskId, controller)
  results.value[index] = {
    ...item,
    loading: true,
    status: 'generating',
    error: '',
    task: item.task || {type: requestSnapshot.operation || requestSnapshot.mode || 'text', label: item.label || '样片'},
    taskId,
    requestSnapshot
  }
  try {
    const response = await generateImage(requestSnapshot, {signal: controller.signal})
    const output = response.data?.[0];
    results.value[index] = {
      ...item,
      loading: false,
      status: output?.url || output?.b64_json ? 'completed' : 'failed',
      error: output?.url || output?.b64_json ? '' : '接口没有返回可预览的图片',
      imageLoading: Boolean(output?.url),
      url: output?.url || (output?.b64_json ? `data:image/png;base64,${output.b64_json}` : ''),
      id: output?.id || item.id,
      taskId: output?.taskId || taskId,
      parentResultId: output?.parentResultId || null,
      version: output?.version || 1,
      requestSnapshot,
      task: item.task || {type: requestSnapshot.operation || requestSnapshot.mode || 'text', label: item.label || '样片'}
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      results.value[index] = {...results.value[index], loading: false, status: 'stopped', error: ''}
    } else {
      results.value[index] = {...results.value[index], loading: false, status: e.details?.generationAcceptedUnknown ? 'uncertain' : 'failed', uncertain: Boolean(e.details?.generationAcceptedUnknown), error: e.message || '生成失败'}
      error.value = e.message || '生成失败'
    }
  } finally {
    generationControllers.delete(taskId)
  }
}

async function exportSelected() {
  const urls = [...selected.value].sort((a, b) => a - b).map((index) => results.value[index]?.url).filter(Boolean)
  if (!urls.length || exporting.value) return
  exporting.value = true
  error.value = ''
  try {
    const exported = await exportImages(urls, format.value)
    showMessage('success', `已导出 ${exported.count} 张图片到 ${exported.exportDir || '本地导出目录'}`)
  } catch (e) {
    error.value = e.message || '导出图片失败'
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  await refresh();
  await restoreHomeMemory()
  normalizeConfigSelection()
  restoringHomeMemory = false
  await restoreHistoryEdit()
})

function onActiveApiChanged() {
  void refresh()
}

function onPromptTemplatesChanged() {
  void refreshPromptTemplates()
}

function onKeydown(event) {
  const tag = event.target?.tagName?.toLowerCase();
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || tag !== 'textarea')) {
    if (tag === 'input' && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    generate()
  }
}

function setPromptHeight(nextHeight) {
  promptHeight.value = Math.max(88, Math.min(420, Math.round(nextHeight)))
}

function startPromptResize(event) {
  if (event.button !== 0) return
  event.preventDefault()
  promptResizeActive.value = true
  const startY = event.clientY
  const startHeight = promptHeight.value
  const onMove = (moveEvent) => setPromptHeight(startHeight + startY - moveEvent.clientY)
  const onEnd = () => {
    promptResizeActive.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    promptResizeCleanup = null
  }
  promptResizeCleanup = onEnd
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}

function resizePromptByKeyboard(event) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') return setPromptHeight(88)
  if (event.key === 'End') return setPromptHeight(420)
  setPromptHeight(promptHeight.value + (event.key === 'ArrowDown' ? 16 : -16))
}

function setLeftRailWidth(nextWidth) {
  leftRailWidth.value = Math.max(220, Math.min(460, Math.round(nextWidth)))
}

function startRailResize(event) {
  if (event.button !== 0) return
  event.preventDefault()
  railResizeActive.value = true
  const startX = event.clientX
  const startWidth = leftRailWidth.value
  const onMove = (moveEvent) => setLeftRailWidth(startWidth + moveEvent.clientX - startX)
  const onEnd = () => {
    railResizeActive.value = false
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    railResizeCleanup = null
  }
  railResizeCleanup = onEnd
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onMounted(() => window.addEventListener('sample-factory-active-api-changed', onActiveApiChanged))
onMounted(() => window.addEventListener('sample-factory-prompt-templates-changed', onPromptTemplatesChanged))
onActivated(() => void refreshPromptTemplates())
watch([
  model,
  modelMode,
  presetId,
  prompt,
  count,
  resolution,
  format,
  size,
  customWidth,
  customHeight,
  mode,
  imageOperation,
  replaceObject,
  editParent,
  materials,
  results
], scheduleHomeMemoryPersist, {deep: true})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('sample-factory-active-api-changed', onActiveApiChanged)
  window.removeEventListener('sample-factory-prompt-templates-changed', onPromptTemplatesChanged)
  window.clearTimeout(persistHomeMemoryTimer)
  promptResizeCleanup?.()
  railResizeCleanup?.()
  if (!restoringHomeMemory) writeHomeMemory(makeHomeMemorySnapshot()).catch(() => null)
})
</script>

<template>
  <div class="v5-home-layout" :class="{ 'is-rail-resizing': railResizeActive }"
       :style="{ '--left-rail-width': `${leftRailWidth}px` }">
    <el-form label-position="top" class="workspace-form">
      <div class="grid">
        <aside class="task-setup" aria-label="本次生成任务">
          <section class="panel">
            <el-button class="rail-new-task" :icon="Plus" @click="startNewTask">新建任务</el-button>

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
                  <el-radio-button label="three-view">三视图</el-radio-button>
<!--                  <el-radio-button label="fusion">多图融合</el-radio-button>-->
<!--                  <el-radio-button label="background">背景替换</el-radio-button>-->
<!--                  <el-radio-button label="prop">道具替换</el-radio-button>-->
                  <el-radio-button label="edit">局部继续编辑</el-radio-button>
                </el-radio-group>
              </el-form-item>
              <p class="operation-hint">{{
                  imageOperation === 'batch' ? '每张目标图独立生成。可选上传一张画面参考图，并在提示词中说明要统一借用的色调、道具或氛围；动作模仿图优先决定动作，人物参考固定身份。' : imageOperation === 'three-view' ? '每张上传图片独立生成一张三视图；可一次选择多张图片，生成后仍可继续添加并再次批量生成。' : imageOperation === 'fusion' ? '人物、主目标、背景和道具共同组成一个融合任务。' : imageOperation === 'background' ? '只使用主目标图和背景参考图，保留前景主体。' : imageOperation === 'prop' ? '只使用主目标图和道具参考图，指定画面中要替换的对象。' : '从结果中选择一张样片作为基础图；可选上传一张编辑参考图，并在提示词中说明要借用的道具、材质或色调。'
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
                <el-upload class="material-upload" drag action="#" :auto-upload="false" :show-file-list="false"
                           :multiple="item.limit > 1"
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
          </section>
          <section class="panel config-panel composer-panel">
            <div class="composer-heading">
              <h3>提示词</h3>
            </div>
            <div class="quick-controls" aria-label="常用生成设置">
              <el-form-item class="quick-control quick-model" label="模型">
                <el-select v-model="model" class="studio-select" filterable allow-create default-first-option :placeholder="configLoading ? '正在加载模型...' : '选择模型，可直接输入模型 ID'" popper-class="studio-select-popper" clearable :loading="configLoading">
                  <el-option v-for="(item, index) in models" :key="item.id" :label="item.id" :value="item.id">
                    <div class="select-option"><span class="select-index">{{ String(index + 1).padStart(2, '0') }}</span><span><b>{{ item.id }}</b><small>{{ item.supportedSizes?.length ? `支持 ${item.supportedSizes.join('、')}` : (index === 0 ? '主力生成模型' : '备用生成模型') }}</small></span></div>
                  </el-option>
                </el-select>
              </el-form-item>
              <el-button class="quick-refresh" text :icon="Refresh" title="刷新模型" aria-label="刷新模型" @click="refresh" :disabled="running"/>
              <el-form-item class="quick-control quick-preset" label="预设">
                <el-select v-model="presetId" class="studio-select" filterable :placeholder="configLoading ? '正在加载预设...' : '未选择预设'" popper-class="studio-select-popper" :loading="configLoading" clearable>
                  <el-option v-for="(item, index) in availableTemplates" :key="item.id" :label="item.name" :value="item.id">
                    <div class="select-option"><span class="select-index">{{ String(index + 1).padStart(2, '0') }}</span><span><b>{{ item.name }}</b></span></div>
                  </el-option>
                </el-select>
              </el-form-item>
              <el-form-item class="quick-control quick-size" label="尺寸">
                <el-select v-model="size" class="studio-select" popper-class="studio-select-popper">
                  <el-option v-for="option in sizeOptions" :key="option.value" :label="option.label" :value="option.value" :disabled="sizeDisabled(option.value)">
                    <span>{{ option.label }}<small v-if="sizeDisabled(option.value)" class="size-option-note">（当前模型不支持）</small></span>
                  </el-option>
                </el-select>
              </el-form-item>
              <el-form-item class="quick-control quick-count" label="数量"><el-input-number v-model="count" :min="1" :max="10" controls-position="right"/></el-form-item>
<!--              <el-form-item class="quick-control quick-format" label="格式">-->
<!--                <el-select v-model="format" class="studio-select" popper-class="studio-select-popper"><el-option label="PNG" value="png"/><el-option label="JPG" value="jpg"/><el-option label="WebP" value="webp"/></el-select>-->
<!--              </el-form-item>-->
              <div v-if="size === 'custom'" class="quick-custom-size"><el-input-number v-model="customWidth" :min="256" :max="4096" :step="8"/><span>×</span><el-input-number v-model="customHeight" :min="256" :max="4096" :step="8"/></div>
            </div>
            <div class="prompt-surface" :class="{ 'is-resizing': promptResizeActive }">
              <button type="button" class="prompt-resize-handle" role="separator"
                      aria-label="调整提示词输入框高度" :aria-valuenow="promptHeight" aria-valuemin="88"
                      aria-valuemax="420" @pointerdown="startPromptResize" @keydown="resizePromptByKeyboard">
                <span aria-hidden="true"></span>
              </button>
              <el-form-item class="composer-prompt" :class="{ 'is-resizing': promptResizeActive }">
                <el-input v-model="prompt" type="textarea" :rows="3"
                          :style="{ '--prompt-height': `${promptHeight}px` }"
                          :placeholder="isTextMode ? '描述想生成的画面、主体、风格和光线' : (imageOperation === 'edit' ? '例如：将编辑参考图中的花替换到桌上花瓶中，其余画面保持不变' : (imageOperation === 'batch' ? '例如：参考画面参考图的色调和光线，调整每张目标图' : '仅填写本次额外要求'))"/>
              </el-form-item>
              <div class="task-action-bar">
                <el-button class="clear-button" @click="clearCurrent">清空当前</el-button>
                <el-button type="primary" :icon="VideoPlay" @click="generate">{{ running ? '追加生成' : '开始生成' }}</el-button>
                <button v-if="running" type="button" class="stop-generation-button" @click="stop"><el-icon><SwitchButton/></el-icon>停止生成</button>
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
    <button type="button" class="left-rail-resize-handle" aria-label="调整左侧布局宽度"
            @pointerdown="startRailResize"></button>
    <section class="panel queue">
      <div class="queue-head">
        <div>
          <h3>样片预览</h3></div>
        <div v-if="running || completedCount" class="generation-status"><span>{{
            running ? (queuedCount ? `正在生成，后面还有 ${queuedCount} 组等待处理` : '正在调用接口生成') : '生成完成'
          }}</span>
          <div class="progress-track"><i :style="{width: progressPercent + '%'}"></i></div>
        </div>
        <div class="queue-actions">
          <el-button :disabled="!results.length || running" @click="toggleSelectAll">
            {{ allResultsSelected ? '取消全选' : '全选' }}
          </el-button>
          <el-button :icon="Delete" plain :disabled="!selectedRemovableCount"
                     @click="removeSelected">删除已选 </el-button>
          <el-button :icon="SwitchButton" plain :disabled="!selectedLoadingCount || !running"
                     @click="stopSelected">停止已选 </el-button>
          <el-button :icon="Download" :loading="exporting" :disabled="!selected.size || exporting || preparingEdit"
                     @click="exportSelected">导出已选 </el-button>
          <el-button :icon="PenLine" :loading="preparingEdit" :disabled="selected.size !== 1 || running || preparingEdit"
                     @click="continueEdit">{{ preparingEdit ? '准备编辑图' : '继续编辑' }}</el-button>
        </div>
      </div>
      <div v-if="!results.length" class="empty">暂无生成结果</div>
      <div v-else class="gallery">
        <div v-for="(item,index) in results" :key="item.id || index" class="result-card"
             :class="{ selected: selected.has(index) }">
          <div v-if="item.loading" class="loading-placeholder">
            <span>{{ item.status === 'generating' ? '正在加载图片...' : '等待生成' }}</span>
            <b>样片 {{ index + 1 }}</b>

            <el-button v-if="item.taskId" size="small" :icon="SwitchButton" @click="stopOne(index)">停止</el-button>
          </div>
          <div v-else-if="item.status === 'stopped'" class="result-stopped">
            <strong>已停止生成</strong>
            <el-button v-if="item.task || item.requestSnapshot" size="small" :icon="Refresh" @click="retry(index)">重试</el-button>
          </div>
          <div v-else-if="item.error" class="result-error" :class="{ 'result-uncertain': item.uncertain }">
            <strong>{{ item.uncertain ? '结果待确认' : '生成失败' }}</strong>
            <span>{{ item.error }}</span>
            <el-button v-if="item.task && !item.uncertain" size="small" :icon="Refresh" @click="retry(index)">重试</el-button>
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

