<script setup>
import { ref, onMounted } from 'vue'
import { Download, Maximize2, X } from 'lucide-vue-next'
import { getRecords, downloadUrl, exportImages } from '../api'
const records = ref([]); const error = ref(''); const preview = ref(null)
function images(record) { return (record.images || []).map((item) => item.url || (item.b64_json ? `data:image/png;base64,${item.b64_json}` : '')).filter(Boolean) }
function download(url) { const link = document.createElement('a'); link.href = downloadUrl(url); link.click() }
async function downloadAll(record) { await exportImages(images(record)) }
onMounted(async () => { try { records.value = await getRecords() } catch (e) { error.value = e.message } })
</script>
<template><section class="page"><span class="eyebrow">HISTORY / GENERATION RECORDS</span><h2>生成记录</h2><p class="muted">保存每次生成的图片、提示词、模型和时间。</p><p v-if="error" class="form-status error">{{ error }}</p><div v-if="!records.length" class="empty">暂无生成记录</div><div v-for="record in records" :key="record.id" class="record-card"><div class="record-meta"><div><b>{{ record.model }}</b><span>{{ new Date(record.createdAt).toLocaleString() }}</span></div><button class="secondary" @click="downloadAll(record)"><Download :size="14" />导出本次图片</button></div><p>{{ record.prompt }}</p><div class="record-images"><div v-for="(image,index) in images(record)" :key="image" class="record-image"><img :src="image" alt="生成结果" /><button @click="preview=image"><Maximize2 :size="14" /></button><button @click="download(image,record,index)"><Download :size="14" /></button></div></div></div><div v-if="preview" class="preview-modal" @click.self="preview=null"><button class="preview-close" @click="preview=null"><X /></button><img :src="preview" alt="记录图片预览" /></div></section></template>
