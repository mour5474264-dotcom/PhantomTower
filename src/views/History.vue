<script setup>
import {ref, computed, onMounted} from 'vue'
import {useRouter} from 'vue-router'
import {Download, Maximize2, X} from 'lucide-vue-next'
import {getRecords, downloadImage, exportImages, makeImageFilename} from '../api'

const records = ref([]);
const error = ref('');
const preview = ref(null)
const router = useRouter()
const taskGroups = computed(() => {
  const groups = new Map()
  for (const record of records.value) {
    const id = record.request?.taskId || record.id
    if (!groups.has(id)) groups.set(id, {id, records: []})
    groups.get(id).records.push(record)
  }
  return [...groups.values()]
})

function images(record) {
  return (record.images || []).map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '')).filter(Boolean)
}

function imageTokens(record) {
  const values = (record.responses || [])
    .map((response) => response?.usage?.input_tokens_details?.image_tokens)
    .filter((value) => Number.isFinite(value))
  return values.length ? values.reduce((total, value) => total + value, 0) : null
}

function imageInputStatus(record) {
  const tokens = imageTokens(record)
  if (!record.request?.imageCount) return '未使用参考图'
  if (tokens === null) return '接口未返回图像用量'
  return tokens > 0 ? '参考图已识别' : '参考图未识别'
}

async function download(url, record, index) {
  await downloadImage(url, makeImageFilename(index + 1, 'png'))
}

async function downloadAll(record) {
  await exportImages(images(record))
}

function continueEdit(image, record) {
  sessionStorage.setItem('sample-factory-continue-edit', JSON.stringify({url: image.url || image, id: image.id, version: image.version || record.request?.version || 1}))
  router.push('/')
}

onMounted(async () => {
  try {
    records.value = await getRecords()
  } catch (e) {
    error.value = e.message
  }
})
</script>
<template>
  <section class="page"><span class="eyebrow">HISTORY / GENERATION RECORDS</span>
    <h2>生成记录</h2>
    <p class="muted">保存每次生成的图片、提示词、模型和时间。</p>
    <p v-if="error" class="form-status error">{{ error }}</p>
    <div v-if="!records.length" class="empty">暂无生成记录</div>
    <section v-for="group in taskGroups" :key="group.id" class="record-group">
      <h3>任务 {{ group.id.slice(0, 8) }} <small>{{ group.records.length }} 次生成</small></h3>
      <div v-for="record in group.records" :key="record.id" class="record-card">
      <div class="record-meta">
        <div><b>{{ record.model }}</b><span>{{ new Date(record.createdAt).toLocaleString() }}</span></div>
        <button class="secondary" @click="downloadAll(record)">
          <Download :size="14"/>
          导出本次图片
        </button>
      </div>
      <p class="record-version">{{ record.request?.operation || 'text' }} · V{{ record.request?.version || 1 }}<span v-if="record.request?.parentResultId"> · 续作：{{ record.request.parentResultId }}</span></p>
      <p class="record-version">参考图 {{ record.request?.imageCount || 0 }} 张 · 图像 tokens：{{ imageTokens(record) ?? '接口未返回' }} · {{ imageInputStatus(record) }}</p>
      <p>{{ record.prompt }}</p>
      <div class="record-images">
        <div v-for="(image,index) in images(record)" :key="image" class="record-image"><img :src="image"
                                                                                            alt="生成结果"/>
          <button @click="preview=image">
            <Maximize2 :size="14"/>
          </button>
          <button @click="download(image,record,index)">
            <Download :size="14"/>
          </button>
          <button title="继续编辑" @click="continueEdit(image, record)">继续编辑</button>
        </div>
      </div>
      </div>
    </section>
    <div v-if="preview" class="preview-modal" @click.self="preview=null">
      <button class="preview-close" @click="preview=null">
        <X/>
      </button>
      <img :src="preview" alt="记录图片预览"/></div>
  </section>
</template>
