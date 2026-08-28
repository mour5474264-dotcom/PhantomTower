<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { Check, Download, FolderOpen, RefreshCw, Sparkles } from 'lucide-vue-next'
import { ElMessage } from 'element-plus'
import { getSettings, saveSettings } from '../api'

const loading = ref(true)
const saving = ref(false)
const savedAt = ref('')
const settings = reactive({ schemaVersion: 2, preferences: { homeSize: 'standard' }, storage: { exportDir: '' } })
const updateState = ref('idle')
const updateVersion = ref('')
const updateProgress = ref(0)
const updateMessage = ref('启动时自动检查，也可以手动检查。')
let removeUpdateListener = null
let apis = []
let activeApiId = ''
function apply(data = {}) {
  apis = data.apis || []; activeApiId = data.activeApiId || ''; settings.schemaVersion = data.schemaVersion || 2
  settings.preferences = { ...(data.preferences || {}) }; settings.storage = { exportDir: '', ...(data.storage || {}) }
}
async function load() { try { apply(await getSettings()) } catch (error) { ElMessage.error(error.message) } finally { loading.value = false } }
async function save(silent = false) {
  saving.value = true
  try {
    await saveSettings({ schemaVersion: 2, apis, activeApiId, preferences: settings.preferences, storage: settings.storage })
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); if (!silent) ElMessage.success('设置已保存')
  } catch (error) { if (!silent) { ElMessage.error(error.message); throw error } } finally { saving.value = false }
}
async function chooseDirectory() {
  if (window.phantomTowerLicense?.chooseDirectory) {
    const selected = await window.phantomTowerLicense.chooseDirectory(); if (selected) { settings.storage.exportDir = selected; await save(true) }
    return
  }
  ElMessage.info('浏览器出于安全限制无法读取完整本机路径，请直接输入路径，离开输入框后会自动保存')
}
async function checkForUpdate() {
  if (!window.phantomTowerUpdate) return ElMessage.info('开发模式暂不检查更新')
  updateState.value = 'checking'; updateMessage.value = '正在检查新版本...'
  try { await window.phantomTowerUpdate.check() } catch (error) { updateState.value = 'error'; updateMessage.value = error.message || '检查更新失败' }
}
async function installUpdate() {
  try { await window.phantomTowerUpdate.install(); updateMessage.value = '已打开更新文件，请完成安装后重新启动应用。' } catch (error) { updateState.value = 'error'; updateMessage.value = error.message || '打开更新失败' }
}
onMounted(() => {
  load()
  if (window.phantomTowerUpdate) removeUpdateListener = window.phantomTowerUpdate.on(({ type, data }) => {
    if (type === 'available') { updateState.value = data.manual ? 'manual' : 'downloading'; updateVersion.value = data.version; updateMessage.value = data.manual ? `发现新版本 ${data.version}，点击下载更新。` : `发现新版本 ${data.version}，正在下载...` }
    if (type === 'progress') { updateState.value = 'downloading'; updateProgress.value = Number(data) || 0; updateMessage.value = `正在下载更新 ${updateProgress.value}%` }
    if (type === 'downloaded') { updateState.value = 'ready'; updateVersion.value = data; updateMessage.value = `版本 ${data} 已下载，重启后完成更新。` }
    if (type === 'not-available') { updateState.value = 'latest'; updateMessage.value = `当前版本 ${data} 已是最新版本。` }
    if (type === 'error') { updateState.value = 'error'; updateMessage.value = String(data || '更新失败') }
  })
})
onUnmounted(() => removeUpdateListener?.())
</script>

<template>
  <section class="page settings-page" :class="{ 'is-loading': loading }">
    <header class="settings-hero"><div class="hero-copy"><span class="eyebrow">APP / PREFERENCES</span><h2>设置中心</h2><p>让样片工厂更贴合你的工作节奏。</p></div><div class="save-state" :class="{ ready: savedAt }"><Check :size="15" />{{ savedAt ? `自动保存于 ${savedAt}` : '修改后自动保存' }}</div></header>
    <div class="settings-layout">
      <main class="settings-main">
        <section class="settings-block path-block"><div class="block-heading"><div class="section-icon orange"><FolderOpen :size="18" /></div><div><h3>图片保存位置</h3><p>生成的图片会默认保存到这个文件夹，修改后自动保存。</p></div></div><label class="field-label" for="export-dir">默认保存路径</label><div class="path-input"><input id="export-dir" v-model="settings.storage.exportDir" placeholder="使用默认数据目录" @change="save(true)" @keyup.enter="save(true)" /><button type="button" title="选择文件夹" aria-label="选择文件夹" @click="chooseDirectory"><FolderOpen :size="17" /></button></div><div class="field-note"><span class="dot"></span>仅保存在本机，不会上传到云端</div></section>
        <section class="settings-block updates-block"><div class="block-heading"><div class="section-icon violet"><Sparkles :size="18" /></div><div><h3>自动更新</h3><p>{{ updateMessage }}</p></div><span class="status-pill">{{ updateState === 'latest' ? '已是最新' : updateState === 'error' ? '检查失败' : updateState === 'checking' ? '检查中' : updateState === 'downloading' ? `${updateProgress}%` : updateState === 'ready' ? '可安装' : updateState === 'manual' ? '有新版本' : '待检查' }}</span></div><div class="update-row"><div><b>{{ updateVersion ? `版本 ${updateVersion}` : '保持应用最新' }}</b><small>Windows 支持下载后重启更新；macOS 将打开 DMG，由你覆盖安装。</small></div><button v-if="['manual','ready'].includes(updateState)" type="button" class="update-button" @click="installUpdate"><Download :size="15" />{{ updateState === 'ready' ? '重启安装' : '打开更新' }}</button><button v-else type="button" class="update-button" :disabled="updateState === 'checking' || updateState === 'downloading'" @click="checkForUpdate"><RefreshCw :size="15" />检查更新</button></div></section>
      </main>
    </div>
  </section>
</template>

<style scoped>
.settings-page{max-width:860px!important;padding:0!important;background:transparent!important;border:0!important}.settings-hero{display:flex;align-items:flex-end;justify-content:space-between;padding:12px 2px 24px;border-bottom:1px solid #d8dfda}.hero-copy h2{margin:7px 0 6px!important;font-size:28px!important;letter-spacing:-.3px}.hero-copy p{margin:0;color:#748079;font-size:13px}.save-state{display:flex;align-items:center;gap:7px;color:#9a6a39;font-size:11px}.save-state.ready{color:#218377}.settings-layout{margin-top:20px}.settings-main{display:grid;gap:12px}.settings-block{padding:22px 24px;border:1px solid #d7dfda;background:#fff;border-radius:5px}.block-heading{display:flex;align-items:flex-start;gap:12px;position:relative}.block-heading h3{margin:0 0 5px;color:#24312c;font-size:15px}.block-heading p{margin:0;color:#7b8780;font-size:11px;line-height:1.5}.section-icon{width:34px;height:34px;display:grid;place-items:center;border-radius:7px;flex:0 0 auto}.section-icon.orange{color:#b15a36;background:#fff0e9}.section-icon.violet{color:#7863a6;background:#f0ecfa}.field-label{display:block;margin:22px 0 7px;color:#516058;font-size:11px;font-weight:700}.path-input{display:flex;gap:8px}.path-input input{min-width:0;flex:1;height:40px;border:1px solid #cbd6d0;border-radius:4px;padding:0 12px;color:#2a3731;background:#fbfcfb;font:12px inherit}.path-input input:focus{outline:2px solid #a8d8ce;outline-offset:1px;border-color:#168374}.path-input button{width:42px;border:1px solid #cbd6d0;border-radius:4px;background:#fff;color:#3a665b;cursor:pointer}.path-input button:hover{background:#edf8f5;border-color:#8ec8bd}.field-note{display:flex;align-items:center;gap:6px;margin-top:9px;color:#89958d;font-size:10px}.dot{width:6px;height:6px;border-radius:50%;background:#5eb7a6}.updates-block{padding-bottom:14px}.coming-soon{margin-left:auto;padding:5px 8px;border:1px solid #ddd7eb;border-radius:20px;color:#76669a;background:#f6f3fc;font-size:10px;white-space:nowrap}.update-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 0 46px;padding-top:15px;border-top:1px solid #e6ebe8}.update-row b,.update-row small{display:block}.update-row b{font-size:12px;color:#415049}.update-row small{margin-top:4px;color:#8b958f;font-size:10px}.status-pill{padding:5px 9px;border-radius:3px;color:#7a6b98;background:#f1eef8;font-size:10px}.settings-footer{display:flex;justify-content:flex-end;margin-top:18px;padding-bottom:12px}.save-button{display:inline-flex;align-items:center;gap:7px;min-height:38px;padding:0 18px;border:1px solid #167d70;border-radius:4px;background:#167d70;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 12px #167d7025}.save-button:hover:not(:disabled){background:#0f6258}.save-button:disabled{opacity:.55;cursor:wait}@media(max-width:560px){.settings-hero{align-items:flex-start;gap:12px;flex-direction:column}.settings-block{padding:18px}.update-row{margin-left:0}}
.update-button{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:0 12px;border:1px solid #167d70;border-radius:4px;background:#fff;color:#167d70;font-size:11px;cursor:pointer}.update-button:hover:not(:disabled){background:#edf8f5}.update-button:disabled{opacity:.5;cursor:wait}
</style>
