<script setup>
import {computed, onBeforeUnmount, onMounted, ref} from 'vue'
import {ElMessage} from 'element-plus'
import {uploadImageAsset, processTextureImage, exportImages} from '../api'

const items = ref([])
const picker = ref(null)
const uploading = ref(false)
const running = ref(false)
const stopping = ref(false)
const exporting = ref(false)
const completed = ref(0)
const total = ref(0)
const notice = ref('')
let batch = 0
const chosen = computed(() => items.value.filter(item => item.selected))
const outputs = computed(() => chosen.value.filter(item => item.output))
const allSelected = computed(() => items.value.length > 0 && items.value.every(item => item.selected))
const busy = computed(() => running.value || uploading.value || exporting.value)
const labels = {ready: '待处理', processing: '正在处理', done: '已完成', failed: '处理失败'}

function importWorkspaceSelection() {
  let sources = []
  try { sources = JSON.parse(sessionStorage.getItem('phantom-tower-texture-selection') || '[]') } catch {}
  sessionStorage.removeItem('phantom-tower-texture-selection')
  if (!Array.isArray(sources)) return
  sources.filter(value => typeof value === 'string' && value).forEach((source, index) => {
    items.value.push({id: crypto.randomUUID(), name: `创作台结果 ${index + 1}`, group: '创作台',
      asset: source, original: source, selected: true, status: 'ready', output: '', error: '', settings: null})
  })
}

async function addFiles(files) {
  if (busy.value) return
  uploading.value = true
  notice.value = ''
  const group = ++batch
  const errors = []
  try {
    for (const file of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
        errors.push(`${file.name}：请选择 20 MB 以内的 JPG、PNG 或 WebP`)
        continue
      }
      try {
        const asset = await uploadImageAsset(file)
        if (!asset.assetId) throw new Error('未返回图片资源')
        items.value.push({id: crypto.randomUUID(), name: file.name, group,
          asset: asset.assetId, original: URL.createObjectURL(file), selected: true,
          status: 'ready', output: '', error: '', settings: null})
      } catch (error) { errors.push(`${file.name}：${error.message}`) }
    }
    notice.value = errors.join('\n')
    const newItems = items.value.filter(item => item.group === group && item.status === 'ready')
    uploading.value = false
    if (newItems.length) await processBatch(newItems)
  } finally { uploading.value = false }
}
function pick(event) {
  const files = [...event.target.files]
  event.target.value = ''
  void addFiles(files)
}
function openPicker() {
  if (!busy.value) picker.value?.click()
}
function removeItems(targets) {
  if (busy.value || !targets.length) return
  const ids = new Set(targets.map(item => item.id))
  targets.forEach(item => URL.revokeObjectURL(item.original))
  items.value = items.value.filter(item => !ids.has(item.id))
  completed.value = 0
  total.value = 0
  notice.value = `已从列表移除 ${ids.size} 张图片。`
}
function remove(item) { removeItems([item]) }
function removeSelected() { removeItems(chosen.value) }
function clearAll() { removeItems([...items.value]) }
function selectFailed() {
  if (busy.value) return
  items.value.forEach(item => item.selected = item.status === 'failed')
}
async function processBatch(targets = chosen.value) {
  if (busy.value || !targets.length) return
  const queue = [...targets]
  const settings = {mode: 'metadata', format: 'png'}
  running.value = true
  stopping.value = false
  completed.value = 0
  total.value = queue.length
  notice.value = ''
  try {
    for (const item of queue) {
      if (stopping.value) break
      item.status = 'processing'
      item.error = ''
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 120000)
        let result
        try {
          result = await processTextureImage(item.asset, {...settings, signal: controller.signal})
        } finally {
          clearTimeout(timer)
        }
        item.output = result.url
        item.settings = {...settings}
        item.status = 'done'
      } catch (error) {
        item.error = error?.name === 'AbortError' ? '处理超时（超过 120 秒），请重试' : (error.message || '处理失败')
        item.status = 'failed'
      }
      completed.value++
    }
    notice.value = `${stopping.value ? '已停止' : '本批结束'}：完成 ${completed.value} / ${total.value} 张任务，成功 ${queue.filter(item => item.status === 'done').length} 张。`
  } finally { running.value = false; stopping.value = false }
}
async function save(targets = outputs.value) {
  if (busy.value || !targets.length) return
  exporting.value = true
  try {
    const result = await exportImages(targets.map(item => item.output))
    ElMessage.success(`已导出 ${result.count} 张到 ${result.exportDir}`)
  } catch (error) { notice.value = error.message }
  finally { exporting.value = false }
}
onBeforeUnmount(() => {
  stopping.value = true
  items.value.forEach(item => URL.revokeObjectURL(item.original))
})
onMounted(importWorkspaceSelection)
</script>

<template>
  <section class="page texture-page">
    <header class="texture-heading"><div><span class="eyebrow">IMAGE FINISHING</span><h2>去 AI 识别 · 批量图片处理</h2><p>清理图片元数据，保留原始尺寸，无损 PNG 输出，不添加颗粒。</p></div>
      <el-button type="primary" :loading="uploading" :disabled="busy" @click="openPicker">追加上传图片</el-button>
      <input ref="picker" hidden type="file" multiple accept="image/jpeg,image/png,image/webp" @change="pick">
    </header>
    <div class="texture-drop" @dragover.prevent @drop.prevent="addFiles([...$event.dataTransfer.files])">
      <button type="button" :disabled="busy" @click="openPicker">拖入多张图片，或点击选择</button>
      <span>JPG / PNG / WebP · 单张最大 20 MB · 再次上传会追加，不替换已有图片</span>
    </div>
    <div class="texture-toolbar">
      <span class="texture-output-note">原尺寸 · 无损 PNG · 不添加颗粒</span>
      <el-button type="primary" :disabled="busy || !chosen.length" @click="processBatch()">处理已选 {{ chosen.length }} 张</el-button>
      <el-button v-if="running" :disabled="stopping" @click="stopping = true">{{ stopping ? '等待当前图片完成' : '停止后续处理' }}</el-button>
      <el-button :loading="exporting" :disabled="busy || !outputs.length" @click="save()">导出已选结果 {{ outputs.length }} 张</el-button>
    </div>
    <div class="texture-summary" aria-live="polite"><label><input type="checkbox" :checked="allSelected" :disabled="busy || !items.length" @change="items.forEach(item => item.selected = $event.target.checked)"> 全选</label><span>已上传 {{ items.length }} 张 · 已选 {{ chosen.length }} 张</span><span v-if="uploading">正在上传图片…</span><span v-else-if="running">正在调用本地处理服务：{{ completed }} / {{ total }}</span><span v-else-if="items.length">处理完成 {{ items.filter(item => item.status === 'done').length }} 张</span></div>
    <div class="texture-list-actions">
<!--      <el-button :disabled="busy || !items.some(item => item.status === 'failed')" @click="selectFailed">选中失败项</el-button>-->
      <el-button type="danger" plain :disabled="busy || !chosen.length" @click="removeSelected">批量删除 {{ chosen.length }} 张</el-button>
      <el-button type="danger" plain :disabled="busy || !items.length" @click="clearAll">全部清空</el-button>
      <span>仅移除列表项，原始文件和已导出的图片保留。</span>
    </div>
    <p v-if="notice" class="texture-notice" role="status">{{ notice }}</p>
    <p v-if="!items.length" class="texture-placeholder">上传后，每张图片的原图和处理效果都会在这里并排显示。</p>
    <div class="texture-cards">
      <article v-for="item in items" :key="item.id" class="texture-card">
        <div class="texture-card-head"><label><input v-model="item.selected" type="checkbox" :disabled="busy"> <b :title="item.name">{{ item.name }}</b></label><small>第 {{ item.group }} 次上传 · {{ labels[item.status] }}</small></div>
        <div class="texture-pair">
          <figure><figcaption>原图</figcaption><el-image :src="item.original" fit="contain" :preview-src-list="[item.original, item.output].filter(Boolean)" preview-teleported hide-on-click-modal /></figure>
          <figure><figcaption>处理后 <small v-if="item.settings">PNG · 无损</small></figcaption><el-image v-if="item.output" :src="item.output" fit="contain" :preview-src-list="[item.original,item.output]" :initial-index="1" preview-teleported hide-on-click-modal /><div v-else class="texture-pending">{{ item.status === 'processing' ? '正在生成处理效果…' : '等待处理' }}</div></figure>
        </div>
        <p v-if="item.error" class="texture-error" role="alert">{{ item.error }}<span v-if="item.output">（仍保留上次成功结果）</span></p>
        <div class="texture-card-actions"><el-button size="small" :disabled="busy" @click="processBatch([item])">{{ item.output ? '重新处理' : item.status === 'failed' ? '重试' : '处理此图' }}</el-button><el-button size="small" :disabled="busy || !item.output" @click="save([item])">导出此图</el-button><el-button size="small" :disabled="busy" @click="remove(item)">移除</el-button></div>
      </article>
    </div>
    <p class="texture-footnote">点击图片可放大对比。切换页面保留当前列表，关闭或刷新应用后需重新导入；请及时导出处理结果。</p>
  </section>
</template>

<style scoped>
.texture-list-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:14px}.texture-list-actions span,.texture-output-note{font-size:12px;color:#64786e}.texture-list-actions :deep(.el-button){margin-left:0}
.texture-cards{max-height:calc(100vh - 360px);overflow-y:auto;padding:4px 8px 18px 0}
.texture-page{max-width:1500px;margin:20px auto;padding:24px;color:#243b33}.texture-heading{gap:20px;flex-wrap:wrap}.texture-heading h2{margin:8px 0;font:600 22px sans-serif}.texture-heading p,.texture-footnote{font-size:12px;color:#64786e;line-height:1.7}.texture-drop{margin:20px 0;padding:22px;border:1px dashed #90aba0;background:#edf3ef;display:grid;gap:8px;text-align:center}.texture-drop button{border:0;background:none;color:#176b5e;font-size:15px;cursor:pointer}.texture-drop span{font-size:12px;color:#64786e}.texture-toolbar{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.texture-toolbar label{display:grid;gap:6px;font-size:12px}.texture-toolbar select,.texture-toolbar input{height:34px;padding:0 10px;border:1px solid #bacdc3;border-radius:4px;background:white;color:#243b33}.texture-toolbar input{width:90px}.texture-summary{display:flex;flex-wrap:wrap;gap:20px;padding:18px 0;font-size:13px}.texture-notice{white-space:pre-wrap;padding:12px;background:#e9f0ec;font-size:13px}.texture-placeholder{text-align:center;padding:60px 12px;color:#64786e}.texture-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,470px),1fr));gap:18px}.texture-card{border:1px solid #c9d6ce;background:white;border-radius:5px;overflow:hidden}.texture-card-head{padding:12px;display:flex;gap:10px;justify-content:space-between;align-items:center}.texture-card-head label{display:flex;gap:6px;align-items:center;min-width:0}.texture-card-head b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.texture-card-head small{flex-shrink:0;color:#61786b;font-size:11px}.texture-pair{display:grid;grid-template-columns:1fr 1fr;gap:2px;background:#dae2dd}.texture-pair figure{margin:0;min-width:0;background:#eaf0ec}.texture-pair figcaption{padding:8px 12px;font-size:12px}.texture-pair figcaption small{color:#637b6b}.texture-pair :deep(.el-image){width:100%;height:260px;display:block}.texture-pending{height:260px;display:grid;place-items:center;color:#718378;font-size:13px}.texture-card-actions{padding:12px;display:flex;justify-content:flex-end}.texture-error{padding:0 12px;color:#a43232;font-size:12px;overflow-wrap:anywhere}input[type=checkbox]{accent-color:#167d70}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #167d70;outline-offset:3px}@media(max-width:650px){.texture-page{padding:14px}.texture-card-head{flex-wrap:wrap}.texture-pair :deep(.el-image),.texture-pending{height:200px}}
</style>
