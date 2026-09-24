<script setup>
import {ref, computed, onMounted, onBeforeUnmount} from 'vue'
import {useRouter} from 'vue-router'
import {Download, Info, Maximize2, Search, Trash2, X} from 'lucide-vue-next'
import {deleteAllRecords, deleteRecord, getRecordPage, downloadImage, exportImages, makeImageFilename, formatApiError, normalizeImageUrl} from '../api'
import {ElMessage, ElMessageBox} from 'element-plus'

const records = ref([]);
const error = ref('');
const preview = ref(null)
const selectedRecord = ref(null)
const exportingRecord = ref('')
const savingImage = ref('')
const deletingRecord = ref('')
const deletingAll = ref(false)
const loadingRecords = ref(false)
const page = ref(1)
const pageSize = ref(Number(localStorage.getItem('history-page-size')) || 20)
const total = ref(0)
const timeRange = ref([])
const gridColumns = ref(Number(localStorage.getItem('history-grid-columns')) || 4)
const router = useRouter()

function setGridColumns(value) {
  gridColumns.value = Number(value) || 4
  localStorage.setItem('history-grid-columns', String(gridColumns.value))
}

async function setPageSize(value) {
  pageSize.value = Number(value) || 20
  localStorage.setItem('history-page-size', String(pageSize.value))
  page.value = 1
  await loadRecords()
}

const recordItems = computed(() => records.value.flatMap((record) => (
  images(record).map((url, index) => ({record, url, index}))
)))

function hasRecordInfo(record) {
  return Boolean(record?.model || record?.upstreamName || record?.prompt || record?.request?.effectivePrompt)
}

function recordPrompt(record) {
  return record?.prompt || ''
}

function effectiveRecordPrompt(record) {
  return record?.request?.effectivePrompt || ''
}

function closeRecordInfo() {
  selectedRecord.value = null
}

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
    total.value = Math.max(0, total.value - 1)
    const lastPage = Math.max(1, Math.ceil(total.value / pageSize.value))
    if (page.value > lastPage) page.value = lastPage
    deletingRecord.value = ''
    await loadRecords({notify: false})
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
    total.value = 0
    ElMessage.success(result?.count ? `已删除 ${result.count} 条生成记录` : '暂无生成记录可删除')
  } catch (e) {
    if (e !== 'cancel' && e !== 'close') ElMessage.error(formatApiError(e, '生成记录删除失败，请稍后重试'))
  } finally {
    deletingAll.value = false
  }
}

function queryTime(value, endOfMinute = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  if (endOfMinute) date.setSeconds(59, 999)
  return date.toISOString()
}

async function loadRecords({notify = false} = {}) {
  if (loadingRecords.value || deletingAll.value || deletingRecord.value || exportingRecord.value) return
  loadingRecords.value = true
  error.value = ''
  try {
    const range = Array.isArray(timeRange.value) ? timeRange.value : []
    const result = await getRecordPage({
      page: page.value,
      pageSize: pageSize.value,
      startTime: queryTime(range[0]),
      endTime: queryTime(range[1], true)
    })
    records.value = Array.isArray(result?.data) ? result.data : []
    total.value = Number(result?.total || 0)
    if (notify) ElMessage.success('生成记录搜索完成')
  } catch (e) {
    error.value = formatApiError(e, '生成记录读取失败')
    if (notify) ElMessage.error(error.value)
  } finally {
    loadingRecords.value = false
  }
}

async function searchRecords() {
  page.value = 1
  await loadRecords({notify: true})
}

async function changePage(value) {
  page.value = value
  await loadRecords()
}

function closePreview() {
  preview.value = null
}

function onPreviewKeydown(event) {
  if (event.key === 'Escape' && preview.value) closePreview()
  if (event.key === 'Escape' && selectedRecord.value) closeRecordInfo()
}

function continueEdit(image, record) {
  sessionStorage.setItem('sample-factory-continue-edit', JSON.stringify({url: image.url || image, id: image.id, version: image.version || record.request?.version || 1}))
  router.push('/')
}

onMounted(async () => {
  window.addEventListener('keydown', onPreviewKeydown)
  await loadRecords()
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
        <div class="history-density-control" aria-label="每行显示数量">
          <span>每行</span>
          <el-select :model-value="gridColumns" size="small" aria-label="每行显示数量" @update:model-value="setGridColumns">
            <el-option v-for="count in [2, 3, 4, 5, 6]" :key="count" :label="`${count} 列`" :value="count" />
          </el-select>
        </div>
        <div class="history-search" role="search">
          <el-date-picker v-model="timeRange" type="datetimerange" range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间" value-format="YYYY-MM-DDTHH:mm:ss" format="YYYY-MM-DD HH:mm" clearable aria-label="生成记录时间范围" @keyup.enter="searchRecords" />
          <el-button type="primary" :icon="Search" class="history-search-button" title="按时间搜索生成记录" aria-label="按时间搜索生成记录" :loading="loadingRecords" :disabled="deletingAll || Boolean(deletingRecord) || Boolean(exportingRecord)" @click="searchRecords">
            {{ loadingRecords ? '搜索中' : '搜索' }}
          </el-button>
        </div>
        <button type="button" class="secondary history-clear" title="删除全部生成记录" aria-label="删除全部生成记录" :disabled="!records.length || deletingAll || Boolean(deletingRecord) || Boolean(exportingRecord) || loadingRecords" @click="removeAllRecords">
          <Trash2 :size="14"/>
          {{ deletingAll ? '正在删除' : '删除全部' }}
        </button>
      </div>
    </div>
    <div v-if="total" class="history-pagination">
      <div class="history-pagination-controls">
        <span>每页</span>
        <el-select :model-value="pageSize" size="small" aria-label="每页显示数量" :disabled="loadingRecords" @update:model-value="setPageSize">
          <el-option v-for="count in [10, 20, 30, 50, 100]" :key="count" :label="`${count} 条`" :value="count" />
        </el-select>
        <el-pagination background layout="total, prev, pager, next" :current-page="page" :page-size="pageSize" :total="total" :disabled="loadingRecords" @current-change="changePage" />
      </div>
    </div>
    <div class="history-scroll">
       <p v-if="error" class="form-status error" role="alert">{{ error }}</p>
      <div v-if="!records.length" class="empty">暂无生成记录</div>
      <div v-else-if="!recordItems.length" class="empty">记录中暂无可展示的图片</div>
      <div v-else class="history-grid" :style="{'--history-columns': gridColumns}">
        <article v-for="item in recordItems" :key="`${item.record.id}-${item.index}`" class="record-card">
          <div class="record-card-head">
            <div class="record-time">{{ formatRecordTime(item.record.createdAt) }}</div>
            <span v-if="item.record.request?.builtinVariant" class="record-variant">{{ item.record.request.builtinVariant === 'single' ? '单人替换' : '双人替换' }}</span>
          </div>
          <button class="record-preview" title="预览图片" :aria-label="`预览第 ${item.index + 1} 张图片`" @click="preview=item.url">
            <img :src="item.url" loading="lazy" decoding="async" :alt="`生成记录 ${formatRecordTime(item.record.createdAt)}，第 ${item.index + 1} 张图片`"/>
            <span class="record-preview-icon"><Maximize2 :size="15"/></span>
          </button>
          <p v-if="recordPrompt(item.record) || effectiveRecordPrompt(item.record)" class="record-prompt">{{ recordPrompt(item.record) || effectiveRecordPrompt(item.record) }}</p>
          <div class="record-image-actions">
            <button :title="savingImage === `${item.record.id}-${item.index}` ? '正在保存' : '保存到本地'" :aria-label="savingImage === `${item.record.id}-${item.index}` ? '正在保存' : '保存到本地'" :disabled="Boolean(savingImage)" @click="download(item.url,item.record,item.index)">
              <Download v-if="savingImage !== `${item.record.id}-${item.index}`" :size="14"/>
              <span v-else class="record-save-pending">保存中</span>
            </button>
            <button class="record-continue" @click="continueEdit(item.url, item.record)">继续编辑</button>
            <button v-if="hasRecordInfo(item.record)" class="record-more" title="查看生成信息" aria-label="查看生成信息" @click="selectedRecord = item.record"><Info :size="14"/></button>
            <button class="record-more record-delete" title="删除这条记录" aria-label="删除这条记录" :disabled="deletingAll || deletingRecord === item.record.id || exportingRecord === item.record.id" @click="removeRecord(item.record)"><Trash2 :size="14"/></button>
          </div>
        </article>
      </div>
    </div>
     <div v-if="preview" class="preview-modal" role="dialog" aria-modal="true" aria-label="图片预览" @click.self="closePreview">
       <button class="preview-close" aria-label="关闭图片预览" @click="closePreview">
         <X/>
       </button>
      <img :src="preview" alt="记录图片预览"/></div>
    <div v-if="selectedRecord" class="record-info-modal" role="dialog" aria-modal="true" aria-label="生成信息" @click.self="closeRecordInfo">
      <article class="record-info-dialog">
        <button class="record-info-close" aria-label="关闭生成信息" @click="closeRecordInfo"><X :size="18"/></button>
        <div class="record-info-kicker">GENERATION INFO</div>
        <h3>生成信息</h3>
        <dl class="record-info-list">
          <div><dt>生成时间</dt><dd>{{ formatRecordTime(selectedRecord.createdAt) }}</dd></div>
          <div v-if="selectedRecord.model"><dt>模型</dt><dd>{{ selectedRecord.model }}</dd></div>
          <div v-else-if="selectedRecord.upstreamName"><dt>工作台</dt><dd>{{ selectedRecord.upstreamName }}</dd></div>
          <div v-if="selectedRecord.request?.version"><dt>版本</dt><dd>V{{ selectedRecord.request.version }}</dd></div>
          <div v-if="selectedRecord.request?.operation"><dt>操作</dt><dd>{{ selectedRecord.request.operation }}</dd></div>
          <div><dt>图片数量</dt><dd>{{ images(selectedRecord).length }} 张</dd></div>
        </dl>
        <div v-if="recordPrompt(selectedRecord)" class="record-info-prompt">
          <div class="record-info-label">自定义提示词</div>
          <p>{{ recordPrompt(selectedRecord) }}</p>
        </div>
        <div v-if="effectiveRecordPrompt(selectedRecord) && effectiveRecordPrompt(selectedRecord) !== recordPrompt(selectedRecord)" class="record-info-prompt">
          <div class="record-info-label">完整发送提示词</div>
          <p>{{ effectiveRecordPrompt(selectedRecord) }}</p>
        </div>
      </article>
    </div>
  </section>
</template>
