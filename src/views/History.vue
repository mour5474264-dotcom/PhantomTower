<script setup>
import {ref, onMounted, onBeforeUnmount} from 'vue'
import {useRouter} from 'vue-router'
import {Download, Maximize2, RefreshCw, Trash2, X} from 'lucide-vue-next'
import {deleteAllRecords, deleteRecord, getRecords, downloadImage, exportImages, makeImageFilename, formatApiError, normalizeImageUrl} from '../api'
import {ElMessage, ElMessageBox} from 'element-plus'

const records = ref([]);
const error = ref('');
const preview = ref(null)
const exportingRecord = ref('')
const savingImage = ref('')
const deletingRecord = ref('')
const deletingAll = ref(false)
const loadingRecords = ref(false)
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
  return (record.images || []).map((item) => {
    if (typeof item === 'string') return normalizeImageUrl(item)
    const direct = item?.url || item?.sourceUrl || item?.image_url?.url || (typeof item?.image_url === 'string' ? item.image_url : '')
    if (direct) return normalizeImageUrl(direct)
    const encoded = item?.b64_json || item?.base64 || item?.base64Data || item?.inlineData?.data || item?.inline_data?.data
    if (!encoded) return ''
    if (/^data:image\//i.test(encoded)) return encoded
    const mimeType = item?.mime_type || item?.mimeType || item?.inlineData?.mimeType || item?.inline_data?.mime_type || 'image/png'
    return `data:${mimeType};base64,${encoded}`
  }).filter(Boolean)
}

async function download(url, record, index) {
  const imageKey = `${record.id}-${index}`
  if (savingImage.value) return
  savingImage.value = imageKey
  try {
    const saved = await downloadImage(url, makeImageFilename(index + 1, 'png'))
    ElMessage.success(`已保存到 ${saved.exportDir || saved.path}`)
  } catch (e) {
    ElMessage.error(formatApiError(e, '图片保存失败，请稍后重试'))
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
  } catch (e) {
    ElMessage.error(formatApiError(e, '图片导出失败，请稍后重试'))
  } finally {
    exportingRecord.value = ''
  }
}

async function removeRecord(record) {
  if (deletingRecord.value || deletingAll.value) return
  try {
    await ElMessageBox.confirm('删除后将不再显示这条生成记录。', '确认删除', {
      type: 'warning',
      confirmButtonText: '确定删除',
      cancelButtonText: '取消'
    })
    deletingRecord.value = record.id
    await deleteRecord(record.id)
    records.value = records.value.filter((item) => item.id !== record.id)
    ElMessage.success('生成记录已删除')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(formatApiError(e, '生成记录删除失败，请稍后重试'))
  } finally {
    deletingRecord.value = ''
  }
}

async function removeAllRecords() {
  if (!records.value.length || deletingAll.value || deletingRecord.value || exportingRecord.value || loadingRecords.value) return
  try {
    await ElMessageBox.confirm('删除后将不再显示任何生成记录。此操作不可撤销。', '确认删除全部记录', {
      type: 'warning',
      confirmButtonText: '确定删除全部',
      cancelButtonText: '取消'
    })
    deletingAll.value = true
    const result = await deleteAllRecords()
    records.value = []
    ElMessage.success(result?.count ? `已删除 ${result.count} 条生成记录` : '暂无生成记录可删除')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(formatApiError(e, '生成记录删除失败，请稍后重试'))
  } finally {
    deletingAll.value = false
  }
}

async function refreshRecords({notify = true} = {}) {
  if (loadingRecords.value || deletingAll.value || deletingRecord.value || exportingRecord.value) return
  loadingRecords.value = true
  error.value = ''
  try {
    records.value = await getRecords()
    if (notify) ElMessage.success('生成记录已刷新')
  } catch (e) {
    error.value = formatApiError(e, '生成记录读取失败')
    if (notify) ElMessage.error(error.value)
  } finally {
    loadingRecords.value = false
  }
}

function closePreview() {
  preview.value = null
}

function onPreviewKeydown(event) {
  if (event.key === 'Escape' && preview.value) closePreview()
}

function continueEdit(image, record) {
  sessionStorage.setItem('sample-factory-continue-edit', JSON.stringify({url: image.url || image, id: image.id, version: image.version || record.request?.version || 1}))
  router.push('/')
}

onMounted(async () => {
  window.addEventListener('keydown', onPreviewKeydown)
  await refreshRecords({notify: false})
})
onBeforeUnmount(() => window.removeEventListener('keydown', onPreviewKeydown))
</script>
<template>
  <section class="page history-page">
    <span class="eyebrow">HISTORY</span>
    <div class="history-heading">
      <div>
        <h2>生成记录</h2>
        <p class="muted">按时间查看已生成的图片。</p>
      </div>
      <div class="history-heading-actions">
        <button type="button" class="secondary history-refresh" title="刷新生成记录" aria-label="刷新生成记录" :disabled="loadingRecords || deletingAll || Boolean(deletingRecord) || Boolean(exportingRecord)" @click="refreshRecords">
          <RefreshCw :size="14" :class="{'is-spinning': loadingRecords}"/>
          {{ loadingRecords ? '正在刷新' : '刷新' }}
        </button>
        <button type="button" class="secondary history-clear" title="删除全部生成记录" aria-label="删除全部生成记录" :disabled="!records.length || deletingAll || Boolean(deletingRecord) || Boolean(exportingRecord) || loadingRecords" @click="removeAllRecords">
          <Trash2 :size="14"/>
          {{ deletingAll ? '正在删除' : '删除全部' }}
        </button>
      </div>
    </div>
    <div class="history-scroll">
       <p v-if="error" class="form-status error" role="alert">{{ error }}</p>
      <div v-if="!records.length" class="empty">暂无生成记录</div>
      <div v-for="record in records" :key="record.id" class="record-card">
        <div class="record-meta">
          <div><b>生成时间</b><span>{{ formatRecordTime(record.createdAt) }}</span></div>
          <div class="record-meta-actions">
            <button class="secondary" :disabled="deletingAll || exportingRecord === record.id || deletingRecord === record.id" @click="downloadAll(record)">
              <Download :size="14"/>
              {{ exportingRecord === record.id ? '正在导出' : '导出本次图片' }}
            </button>
            <button class="secondary record-delete" :disabled="deletingAll || deletingRecord === record.id || exportingRecord === record.id" @click="removeRecord(record)">
              <Trash2 :size="14"/>
              {{ deletingRecord === record.id ? '正在删除' : '删除' }}
            </button>
          </div>
        </div>
        <p v-if="record.prompt" class="record-prompt">{{ record.prompt }}</p>
        <div class="record-images">
          <div v-for="(image,index) in images(record)" :key="image" class="record-image"><img :src="image"
                                                                                               :alt="`生成记录 ${formatRecordTime(record.createdAt)}，第 ${index + 1} 张图片`"/>
            <div class="record-image-actions">
              <button title="预览" aria-label="预览图片" @click="preview=image"><Maximize2 :size="14"/></button>
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
     <div v-if="preview" class="preview-modal" role="dialog" aria-modal="true" aria-label="图片预览" @click.self="closePreview">
       <button class="preview-close" aria-label="关闭图片预览" @click="closePreview">
         <X/>
       </button>
      <img :src="preview" alt="记录图片预览"/></div>
  </section>
</template>
