<script setup>
import {ref, computed, onMounted, onBeforeUnmount, markRaw} from 'vue'
import {Delete, Upload, Refresh, VideoPlay, VideoPause, Download} from '@element-plus/icons-vue'
import {ElMessage} from 'element-plus'
import {X, Plus, ImagePlus, PenLine} from 'lucide-vue-next'
import {getModels, getPromptTemplates, generateImage, exportImages, imageSaving, downloadUrl} from '../api'

const URL = {
  createObjectURL(value) {
    return value?.previewUrl || (rawFile(value) ? globalThis.URL.createObjectURL(rawFile(value)) : '')
  }
}
const models = ref([]);
const presets = ref([]);
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
const error = ref('');
const controller = ref(null);
const preview = ref('')
const materials = ref({person: [], pose: [], prop: [], scene: [], reference: []})
const showConfig = ref(false)
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

async function getRequestSize(task) {
  if (size.value !== 'reference') return size.value === 'custom' ? `${customWidth.value}x${customHeight.value}` : size.value;
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

async function refreshSavingState(url) {
  while (await imageSaving(url)) await new Promise((resolve) => setTimeout(resolve, 800))
  results.value = results.value.map((item) => item.url === url ? {...item, saving: false} : item)
}
const materialPreviewUrls = computed(() => Object.fromEntries(
    Object.entries(materials.value).map(([key, items]) => [key, items.map((item) => item.previewUrl || '')])
))
const progressTotal = computed(() => totalExpected.value || 0)
const progressPercent = computed(() => progressTotal.value ? Math.min(100, Math.round(completedCount.value / progressTotal.value * 100)) : 0)
const imageTaskCount = computed(() => buildImageTasks().length)
const taskCount = computed(() => isTextMode.value ? (prompt.value.trim() ? 1 : 0) : imageTaskCount.value)
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
  return presets.value.filter((item) => (item.mode === 'all' || item.mode === (isTextMode.value ? 'text' : 'image')) && (!item.operation || item.operation === 'all' || item.operation === operation))
})
const preset = computed(() => availableTemplates.value.find((item) => item.id === presetId.value))
const materialTypes = [
  {key: 'person', label: '人物参考', step: '主体', hint: '固定人物身份、脸部与服装', limit: 3, required: true},
  {key: 'reference', label: '目标 / 构图图', step: '任务', hint: '每张图片单独执行一次人物替换', limit: 30},
  {key: 'prop', label: '道具参考', step: '任务', hint: '每张道具图片单独生成一项', limit: 30}
]
materialTypes.push({key: 'scene', label: '场景参考', step: '任务', hint: '每张场景图片单独生成一项', limit: 30})
const activeMaterialTypes = computed(() => {
  const keys = {
    batch: ['person', 'reference'],
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

async function buildLabeledReferences(task) {
  if (task?.type === 'text') return []
  const labeled = []
  const materialOrder = task.materialKeys || ['person', 'reference', 'pose', 'prop', 'scene']
  for (const key of materialOrder) {
    const items = key === 'reference' && task.item ? [task.item] : materials.value[key]
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
    presetId.value = availableTemplates.value.some((item) => item.id === presetId.value) ? presetId.value : (availableTemplates.value[0]?.id || '')
  } catch (e) {
    error.value = e.message
  }
}

function clearCurrent() {
  Object.keys(materials.value).forEach((key) => {
    materials.value[key] = []
  });
  results.value = [];
  selected.value = new Set();
  prompt.value = '';
  error.value = '';
  completedCount.value = 0;
  showConfig.value = false
}

function setMode(nextMode) {
  if (running.value || mode.value === nextMode) return
  mode.value = nextMode
  error.value = ''
  results.value = []
  selected.value = new Set()
  completedCount.value = 0
  presetId.value = availableTemplates.value[0]?.id || ''
  if (nextMode === 'text' && size.value === 'reference') size.value = '2048x2048'
}

function setImageOperation(nextOperation) {
  if (running.value || imageOperation.value === nextOperation) return
  imageOperation.value = nextOperation
  error.value = ''
  results.value = []
  selected.value = new Set()
  completedCount.value = 0
  presetId.value = availableTemplates.value[0]?.id || ''
}

function operationLabel(operation = imageOperation.value) {
  return ({batch: '逐张批处理', fusion: '多图融合', background: '背景替换', prop: '道具替换', edit: '局部继续编辑'})[operation] || '图生图'
}

function buildImageTasks() {
  const target = materials.value.reference[0]
  if (imageOperation.value === 'batch') {
    return materials.value.reference.map((item, index) => ({
      item, type: 'reference', label: `逐张处理 ${index + 1}`, materialKeys: ['person', 'reference']
    }))
  }
  if (!target) return []
  if (imageOperation.value === 'fusion') {
    return [{item: target, type: 'fusion', label: '多图融合', materialKeys: ['person', 'reference', 'scene', 'prop']}]
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
  if (imageOperation.value === 'batch' && !materials.value.person.length) return '逐张处理需要至少一张人物参考图'
  if (!materials.value.reference.length) return `${operationLabel()}需要一张主目标图`
  if (imageOperation.value === 'background' && !materials.value.scene.length) return '背景替换需要一张背景参考图'
  if (imageOperation.value === 'edit' && !prompt.value.trim()) return '请说明需要修改的局部内容'
  if (imageOperation.value === 'prop') {
    if (!materials.value.prop.length) return '道具替换需要一张道具参考图'
    if (!replaceObject.value.trim()) return '请说明主目标图中需要替换的道具'
  }
  return ''
}

function buildMaterialPrompt(labeled, taskType = 'text', taskLabel = '提示词变化') {
  if (!labeled.length) return '';
  const primary = labeled.find((item) => item.primary)
  const manifest = ['提示词可直接使用“人物参考图”“目标图/构图图”“道具图”“场景参考图”“动作参考图”指代对应类别，无需使用图片序号。', '本次请求会同时发送以上全部参考图；本次主参考图是“' + (primary?.promptLabel || '无') + '”。当规则提到本次目标图或最后一张任务图时，均以本次主参考图为准。', ...labeled.map((item, index) => `图片${index + 1}：${item.promptLabel}${item.primary ? '（本次主参考图）' : ''}（${item.role}）`)].join('\n');
  const rule = taskType === 'reference'
      ? '执行完整人物替换：最后一张目标/构图图决定最终画布、人物骨架和动作，前面的人物参考只决定人物身份、脸部、发型、服装和外观，严禁采用人物参考图中的动作。先完整移除目标图原人物及其全部身体、衣物和肢体，再在同一位置生成替换人物。替换人物必须严格保持目标图原人物的头部朝向、躯干角度、重心、坐姿或站姿、手臂姿势、手部位置、腿部姿势、脚部落点，以及与座椅、石块、栏杆、地面和道具的接触关系。最终画面只能有一个完整人物，必须恰好两条手臂、两只手、两条腿和两只脚；不得保留原人物的腿、手、衣摆、轮廓或影子，不得出现重复肢体、额外肢体、融合肢体、残肢或重影。两条腿必须共同连接同一个骨盆，左侧只有一条腿、右侧只有一条腿；每条腿只能形成一条连续的髋部—膝盖—脚踝—脚掌关节链，禁止从腰部、裙摆或大腿中分叉出额外小腿。目标图中被长裙、石块或身体遮挡的腿必须继续保持遮挡，不得猜测补画；可见脚掌数量必须与目标图完全一致。衣摆、薄纱、倒影和阴影只能表现为衣物或光影，不得形成带膝盖、脚踝或脚掌的第三条腿轮廓。保持目标图的镜头、景别、人物大小和位置、背景、透视、遮挡及光线不变。输出前沿骨盆到双脚逐一检查两条腿的连接关系，发现原人物残留或多余肢体必须修正。'
      : taskType === 'pose'
          ? '保持人物参考中的同一人物，采用最后一张动作参考的姿势和身体朝向；不得带入动作参考人物的身份、脸部和背景。'
      : taskType === 'prop'
              ? '保持人物参考中的同一人物，让人物自然使用最后一张道具参考中的道具；不得带入道具图中的无关人物和背景。'
              : taskType === 'fusion'
                  ? '以主目标图作为画布结构，把人物、背景和道具参考融合到同一画面。主目标图决定构图、透视、遮挡和光线，其余素材只能用于对应角色。'
                  : taskType === 'background'
                      ? '只替换主目标图中人物背后的环境。保持人物、前景遮挡、人物比例、位置、镜头和光线关系不变。'
                      : taskType === 'prop-replace'
                          ? `只替换主目标图中的“${replaceObject.value.trim()}”。保持其他主体、位置、比例、透视、接触关系和光线不变，不生成额外道具。`
                          : taskType === 'local-edit'
                              ? '只修改用户指定的局部内容。保持未提及区域的主体、构图、位置、比例、透视、遮挡和光线不变，不重绘整张图片。'
                          : '只根据补充提示词为人物参考中的同一人物创建一个新变化。';
  return `【本次只处理一个任务：${taskLabel}】\n${manifest}\n\n${rule}`;
}

function buildTasks() {
  if (isTextMode.value) return prompt.value.trim() ? [{item: null, type: 'text', label: '文字生图'}] : []
  return buildImageTasks()
}

async function generate() {
  if (running.value) return;
  const imageError = isTextMode.value ? '' : imageValidationError()
  if (imageError) {
    error.value = imageError;
    return
  }
  if (!model.value) {
    error.value = '请先选择生成模型';
    return
  }
  if (!taskCount.value) {
    error.value = isTextMode.value ? '请填写图像描述' : '请添加目标构图、动作、道具，或填写补充提示词';
    return
  }
  running.value = true;
  completedCount.value = 0;
  selected.value = new Set();
  error.value = '';
  controller.value = new AbortController();
  const tasks = buildTasks()
  const jobs = tasks.flatMap((task) =>
      Array.from({length: count.value}, (_, copyIndex) => ({task, copyIndex}))
  );
  results.value = jobs.map(({task}, index) => ({
    loading: true,
    status: index === 0 ? 'generating' : 'waiting',
    label: task.label,
    task
  }));
  try {
    let jobIndex = 0;
    for (const task of tasks) {
      const labeled = await buildLabeledReferences(task)
      const materialPrompt = buildMaterialPrompt(labeled, task.type, task.label);
      const finalPrompt = [materialPrompt, preset.value?.systemPrompt, preset.value?.defaultNegativePrompt && `Negative prompt: ${preset.value.defaultNegativePrompt}`, prompt.value].filter((value) => value?.trim()).join('\n\n');
      const requestSize = await getRequestSize(task);
      const taskId = crypto.randomUUID()
      for (let index = 0; index < count.value; index += 1) {
        if (controller.value.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        results.value[jobIndex] = {...results.value[jobIndex], status: 'generating'};
        const requestSnapshot = {
          model: model.value,
          prompt: finalPrompt,
          images: labeled.map((item) => item.data),
          materials: labeled,
          n: 1,
          size: requestSize,
          quality: modelMode.value === 'quality' ? 'high' : 'medium',
          format: format.value,
          resolution: resolution.value,
          mask: '',
          taskId,
          parentResultId: task.type === 'local-edit' ? editParent.value?.id || null : null,
          version: task.type === 'local-edit' ? Number(editParent.value?.version || 0) + 1 : 1,
          operation: task.type
        }
        const response = await generateImage(requestSnapshot, {signal: controller.value.signal});
        const output = response.data?.[0];
        results.value[jobIndex] = {
          loading: false,
          imageLoading: Boolean(output?.url),
          url: output?.url || (output?.b64_json ? `data:image/png;base64,${output.b64_json}` : ''),
          saving: Boolean(output?.saving),
           label: task.label,
           task,
            id: output?.id,
           taskId: output?.taskId || taskId,
           parentResultId: output?.parentResultId || null,
           version: output?.version || 1,
           requestSnapshot
        };
        if (output?.saving && output.url) refreshSavingState(output.url).catch(() => {})
        completedCount.value += 1
        jobIndex += 1;
        if (results.value[jobIndex]) results.value[jobIndex] = {...results.value[jobIndex], status: 'generating'};
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') error.value = e.message;
    results.value = []
  } finally {
    running.value = false;
    controller.value = null
  }
}

function stop() {
  controller.value?.abort();
  running.value = false;
  results.value = [];
  error.value = '已停止生成'
}

function toggle(index) {
  if (!results.value[index]?.url) return
  const next = new Set(selected.value)
  next.has(index) ? next.delete(index) : next.add(index)
  selected.value = next
}

async function continueEdit() {
  if (selected.value.size !== 1 || running.value) return
  const index = [...selected.value][0]
  const result = results.value[index]
  if (!result?.url) return
  try {
    error.value = ''
    const response = await fetch(downloadUrl(result.url, `sample-${Date.now()}.${format.value}`))
    if (!response.ok) throw new Error('无法读取已选样片')
    const blob = await response.blob()
    const file = new File([blob], `sample-${Date.now()}.${format.value}`, {type: blob.type || 'image/png'})
    Object.keys(materials.value).forEach((key) => { materials.value[key] = [] })
    materials.value.reference = [markRaw({file, name: file.name, size: file.size, previewUrl: URL.createObjectURL(file)})]
    mode.value = 'image'
    imageOperation.value = 'edit'
    editParent.value = result
    prompt.value = ''
    size.value = 'reference'
    presetId.value = availableTemplates.value[0]?.id || ''
    selected.value = new Set()
    showConfig.value = true
    ElMessage.success('已将选中样片设为编辑基础图')
  } catch (e) {
    error.value = e.message || '无法读取已选样片'
  }
}

async function restoreHistoryEdit() {
  const saved = sessionStorage.getItem('sample-factory-continue-edit')
  if (!saved) return
  sessionStorage.removeItem('sample-factory-continue-edit')
  try {
    const source = JSON.parse(saved)
    const response = await fetch(downloadUrl(source.url, `sample-${Date.now()}.${format.value}`))
    if (!response.ok) throw new Error('无法读取历史样片')
    const blob = await response.blob()
    const file = new File([blob], `sample-${Date.now()}.${format.value}`, {type: blob.type || 'image/png'})
    Object.keys(materials.value).forEach((key) => { materials.value[key] = [] })
    materials.value.reference = [markRaw({file, name: file.name, size: file.size, previewUrl: URL.createObjectURL(file)})]
    mode.value = 'image'; imageOperation.value = 'edit'; editParent.value = source; size.value = 'reference'; showConfig.value = true
  } catch (exception) { error.value = exception.message || '无法读取历史样片' }
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
        saving: Boolean(output?.saving),
        id: output?.id,
       taskId: output?.taskId || item.taskId,
       parentResultId: output?.parentResultId || null,
       version: output?.version || 1,
       requestSnapshot: item.requestSnapshot
    }
    if (output?.saving && output.url) refreshSavingState(output.url).catch(() => {})
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
    if ([...selected.value].some((index) => results.value[index]?.saving)) {
      ElMessage.info('图片仍在保存，导出将在保存完成后继续')
    }
    await exportImages(urls, format.value)
    ElMessage.success('导出成功')
  } catch (e) {
    error.value = e.message || '导出图片失败'
  } finally {
    exporting.value = false
  }
}

onMounted(async () => { await refresh(); await restoreHistoryEdit() })

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
  <section class="intro">
    <div><h2>样片工厂</h2>
      <p>{{ isTextMode ? '填写图像描述，直接生成候选样片。' : '上传并标记素材角色，再生成候选样片。' }}</p></div>
    <div class="intro-actions">
      <el-button :icon="Plus" @click="clearCurrent" :disabled="running">新建对话</el-button>
      <el-button :icon="Refresh" @click="refresh" :disabled="running">刷新模型与预设</el-button>
      <el-button class="config-toggle" @click="showConfig = !showConfig">{{
          showConfig ? '隐藏配置' : '显示配置'
        }}
      </el-button>
      <el-button v-if="!running" type="primary" :icon="VideoPlay" @click="generate">开始生成</el-button>
      <el-button v-else type="danger" :icon="VideoPause" @click="stop">停止生成</el-button>
    </div>
  </section>
  <div class="v5-home-layout" :class="{ 'config-visible': showConfig }">
    <el-form :disabled="running" label-position="top" class="workspace-form">
      <div class="grid">
        <section class="panel"><span class="eyebrow">01 / 生成模式</span>
          <h3>{{ isTextMode ? '文字生图' : '图生图' }}</h3>
          <div class="mode-switch" role="group" aria-label="生成模式">
            <el-button :type="isTextMode ? 'primary' : 'default'" @click="setMode('text')">文字生图</el-button>
            <el-button :type="!isTextMode ? 'primary' : 'default'" @click="setMode('image')">图生图</el-button>
          </div>
          <p class="muted">{{ isTextMode ? '无需上传素材，图像描述将直接发送给生成接口。' : '上传素材并指定角色，提示词仅补充生成意图。' }}</p>
          <div v-if="isTextMode" class="text-prompt">
            <label for="generation-prompt">图像描述</label>
            <el-input id="generation-prompt" v-model="prompt" type="textarea" :rows="8"
                      placeholder="描述想生成的画面、主体、风格和光线" resize="vertical"/>
            <small>提示词会直接用于本次生成</small>
          </div>
          <div v-if="!isTextMode" class="assets">
            <el-form-item label="处理方式" class="image-operation">
              <el-radio-group class="image-operation-options" :model-value="imageOperation" @change="setImageOperation">
                <el-radio-button label="batch">逐张批处理</el-radio-button>
                <el-radio-button label="fusion">多图融合</el-radio-button>
                <el-radio-button label="background">背景替换</el-radio-button>
                <el-radio-button label="prop">道具替换</el-radio-button>
                <el-radio-button label="edit">局部继续编辑</el-radio-button>
              </el-radio-group>
            </el-form-item>
            <p class="operation-hint">{{ imageOperation === 'batch' ? '每张目标图独立生成，人物参考固定身份，目标图保留构图。' : imageOperation === 'fusion' ? '人物、主目标、背景和道具共同组成一个融合任务。' : imageOperation === 'background' ? '只使用主目标图和背景参考图，保留前景主体。' : imageOperation === 'prop' ? '只使用主目标图和道具参考图，指定画面中要替换的对象。' : '从结果中选择一张样片作为基础图，只描述需要修改的局部内容。' }}</p>
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
                  <span>拖入图片，或点击选择</span>
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
        <div v-if="showConfig" class="config-backdrop" @click="showConfig = false"></div>
        <section class="panel config-panel" :class="{ 'drawer-open': showConfig }">
          <button type="button" class="drawer-close" title="关闭配置" @click="showConfig = false">×</button>
          <span class="eyebrow">02 / 生成配置</span>
          <h3>生成配置</h3>
          <el-form-item label="模型版本">
            <el-select v-model="model" class="studio-select" filterable placeholder="选择模型"
                       popper-class="studio-select-popper">
              <el-option v-for="(item, index) in models" :key="item.id" :label="item.id" :value="item.id">
                <div class="select-option"><span class="select-index">{{
                    String(index + 1).padStart(2, '0')
                  }}</span><span><b>{{ item.id }}</b><small>{{ index === 0 ? '主力生成模型' : '备用生成模型' }}</small></span>
                </div>
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="模型模式">
            <el-radio-group v-model="modelMode">
              <el-radio-button label="balanced">均衡</el-radio-button>
              <el-radio-button label="quality">高质量</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="提示词预设">
            <el-select v-model="presetId" class="studio-select" filterable placeholder="未选择预设"
                       popper-class="studio-select-popper">
              <el-option v-for="(item, index) in availableTemplates" :key="item.id" :label="item.name" :value="item.id">
                <div class="select-option"><span class="select-index">{{
                    String(index + 1).padStart(2, '0')
                  }}</span><span><b>{{ item.name }}</b><small>{{ item.systemPrompt?.slice(0, 58) }}...</small></span></div>
              </el-option>
            </el-select>
          </el-form-item>
          <p v-if="preset" class="preset-preview">{{ preset.systemPrompt }}</p>
          <el-form-item v-if="!isTextMode" :label="imageOperation === 'edit' ? '局部修改要求' : '补充提示词'">
            <el-input v-model="prompt" type="textarea" :rows="4" :placeholder="imageOperation === 'edit' ? '例如：只把人物外套改成深蓝色，其余画面保持不变' : '仅填写本次额外要求'"/>
          </el-form-item>
          <el-form-item label="尺寸">
            <el-radio-group v-model="size">
              <el-radio-button v-if="!isTextMode" label="reference">跟随目标图</el-radio-button>
              <el-radio-button label="2048x2048">2048×2048</el-radio-button>
              <el-radio-button label="2560x1440">2560×1440</el-radio-button>
              <el-radio-button label="1440x2560">1440×2560</el-radio-button>
              <el-radio-button label="3024x1296">3024×1296</el-radio-button>
              <el-radio-button label="custom">自定义</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <div v-if="size === 'custom'" class="custom-size">
            <el-input-number v-model="customWidth" :min="256" :max="4096" :step="8"/>
            <span>×</span>
            <el-input-number v-model="customHeight" :min="256" :max="4096" :step="8"/>
          </div>
          <div class="settings-grid">
            <el-form-item label="分辨率">
              <el-select v-model="resolution">
                <el-option label="2K" value="2K"/>
                <el-option label="4K" value="4K"/>
              </el-select>
            </el-form-item>
            <el-form-item label="格式">
              <el-select v-model="format">
                <el-option label="PNG" value="png"/>
                <el-option label="JPG" value="jpg"/>
                <el-option label="WebP" value="webp"/>
              </el-select>
            </el-form-item>
            <el-form-item label="每项生成数量">
              <el-input-number v-model="count" :min="1" :max="10"/>
            </el-form-item>
          </div>
          <section class="config-summary" aria-live="polite">
            <span>预计样片</span>
            <b>{{ totalExpected }}</b>
            <small>{{ expectedFormula }}</small>
            <small>{{ sizeSummary }}</small>
            <em :class="{ 'is-ready': expectedState === '可以生成' }">{{ expectedState }}</em>
          </section>
          <el-button type="primary" class="clear-button" @click="clearCurrent">清空当前</el-button>
        </section>
      </div>
    </el-form>
    <section class="panel queue">
      <div class="queue-head">
        <div><span class="eyebrow">03 / 结果画廊</span>
          <h3>样片预览</h3></div>
        <div v-if="running || completedCount" class="generation-status"><span>{{
            running ? '正在调用接口生成' : '生成完成'
          }}</span><b>{{ completedCount }} / {{ progressTotal }}</b>
          <div class="progress-track"><i :style="{width: progressPercent + '%'}"></i></div>
        </div>
        <el-button :icon="Download" :loading="exporting" :disabled="!selected.size || exporting"
                   @click="exportSelected">导出已选 ({{
            selected.size
          }})
        </el-button>
        <el-button :icon="PenLine" :disabled="selected.size !== 1 || running" @click="continueEdit">继续编辑</el-button>
      </div>
      <el-alert v-if="error" :title="error" type="error" show-icon/>
      <div v-if="!results.length" class="empty">暂无生成结果</div>
      <div v-else class="gallery">
        <div v-for="(item,index) in results" :key="index" class="result-card"
             :class="{ selected: selected.has(index) }">
          <div v-if="item.loading" class="loading-placeholder">
            <span>{{ item.status === 'generating' ? '正在生成' : '等待生成' }}</span>
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
            <span class="result-label">{{ item.label }} · V{{ item.version || 1 }}<small v-if="item.parentResultId">续作</small></span>
            <el-button v-if="item.task" size="small" :icon="Refresh" @click="retry(index)">再次生成</el-button>
          </template>
          <div v-else class="result-error">
            <strong>未生成图片</strong>
            <span>接口没有返回可预览的图片</span>
            <el-button v-if="item.task" size="small" :icon="Refresh" @click="retry(index)">重试</el-button>
          </div>
          <span v-if="item.url && item.imageLoading" class="image-loading-indicator">正在加载图片...</span>
          <span v-if="item.url && item.saving" class="image-loading-indicator">图片保存中...</span>
          <el-checkbox v-if="item.url" :model-value="selected.has(index)" class="result-check"
                       :aria-label="`选择样片 ${index + 1}`" @click.stop @change="toggle(index)"/>
        </div>
      </div>
    </section>
  </div>
</template>
