<script setup>
import {ref, onMounted} from 'vue'
import {useRouter} from 'vue-router'
import {Download, Maximize2, X} from 'lucide-vue-next'
import {getRecords, downloadImage, exportImages, makeImageFilename} from '../api'
import {ElMessage} from 'element-plus'

const records = ref([]);
const error = ref('');
const preview = ref(null)
const exportingRecord = ref('')
const savingImage = ref('')
const router = useRouter()

function formatRecordTime(value) {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function images(record) {
  return (record.images || []).map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '')).filter(Boolean)
}

async function download(url, record, index) {
  const imageKey = `${record.id}-${index}`
  if (savingImage.value) return
  savingImage.value = imageKey
  try {
    const saved = await downloadImage(url, makeImageFilename(index + 1, 'png'))
    ElMessage.success(`已保存到 ${saved.exportDir || saved.path}`)
  } finally {
    savingImage.value = ''
  }
}

async function downloadAll(record) {
  if (exportingRecord.value) return
  exportingRecord.value = record.id
  try {
    const exported = await exportImages(images(record))
    ElMessage.success(`已导出 ${exported.count} 张图片到 ${exported.exportDir || '本地导出目录'}`)
  } finally {
    exportingRecord.value = ''
  }
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
  <section class="page history-page">
    <span class="eyebrow">HISTORY</span>
    <h2>生成记录</h2>
    <p class="muted">按时间查看已生成的图片。</p>
    <div class="history-scroll">
      <p v-if="error" class="form-status error">{{ error }}</p>
      <div v-if="!records.length" class="empty">暂无生成记录</div>
      <div v-for="record in records" :key="record.id" class="record-card">
        <div class="record-meta">
          <div><b>生成时间</b><span>{{ formatRecordTime(record.createdAt) }}</span></div>
          <button class="secondary" :disabled="exportingRecord === record.id" @click="downloadAll(record)">
            <Download :size="14"/>
            {{ exportingRecord === record.id ? '正在导出' : '导出本次图片' }}
          </button>
        </div>
        <p v-if="record.prompt" class="record-prompt">{{ record.prompt }}</p>
        <div class="record-images">
          <div v-for="(image,index) in images(record)" :key="image" class="record-image"><img :src="image"
                                                                                              alt="生成结果"/>
            <div class="record-image-actions">
              <button title="预览" @click="preview=image"><Maximize2 :size="14"/></button>
              <button :title="savingImage === `${record.id}-${index}` ? '正在保存' : '保存到本地'"
                      :disabled="Boolean(savingImage)" @click="download(image,record,index)">
                <Download v-if="savingImage !== `${record.id}-${index}`" :size="14"/>
                <span v-else class="record-save-pending">保存中</span>
              </button>
              <button class="record-continue" @click="continueEdit(image, record)">继续编辑</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div v-if="preview" class="preview-modal" @click.self="preview=null">
      <button class="preview-close" @click="preview=null">
        <X/>
      </button>
      <img :src="preview" alt="记录图片预览"/></div>
  </section>
</template>
