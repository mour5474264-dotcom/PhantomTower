<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { Images, Settings2, Server, History, ChevronDown } from 'lucide-vue-next'
import { getSettings, saveSettings, notifyActiveApiChanged } from './api'

const apiProfiles = ref(JSON.parse(localStorage.getItem('atelier-apis') || '[]'))
const activeApiId = ref(localStorage.getItem('atelier-active-api') || '')
const showApiMenu = ref(false)
const apiSwitching = ref(false)
const apiSwitchError = ref('')
const activeApi = computed(() => apiProfiles.value.find((item) => item.id === activeApiId.value))

async function refreshApiProfiles() {
  try {
    const settings = await getSettings()
    apiProfiles.value = settings.apis || []
    activeApiId.value = settings.activeApiId || ''
    localStorage.setItem('atelier-apis', JSON.stringify(apiProfiles.value))
    notifyActiveApiChanged(activeApiId.value)
  } catch (error) {
    apiSwitchError.value = error.message || '工作台配置读取失败'
  }
}

async function selectApi(id) {
  if (!id || id === activeApiId.value || apiSwitching.value) {
    showApiMenu.value = false
    return
  }
  const previous = activeApiId.value
  activeApiId.value = id
  apiSwitching.value = true
  apiSwitchError.value = ''
  try {
    await saveSettings({apis: apiProfiles.value, activeApiId: id})
    notifyActiveApiChanged(id)
    showApiMenu.value = false
  } catch (error) {
    activeApiId.value = previous
    apiSwitchError.value = error.message || '工作台切换失败'
  } finally {
    apiSwitching.value = false
  }
}

const licenseStatus = ref({ state: 'checking', message: '正在检查授权...' })
const licenseKey = ref('')
const activationError = ref('')
const activating = ref(false)
const isAuthorized = computed(() => licenseStatus.value.state === 'authorized')
const isLocalDevelopment = import.meta.env.DEV && ['localhost', '127.0.0.1'].includes(window.location.hostname)
const desktopLicense = window.phantomTowerLicense
function friendlyActivationError(error) {
  const message = String(error?.message || error || '')
  if (message.includes('invalid_or_expired_license')) return '许可证无效或已过期，请检查 PT 许可证是否完整。'
  if (message.includes('device_limit_reached')) return '该许可证已达到设备数量上限，请联系管理员处理。'
  if (message.includes('ERR_CONNECTION_REFUSED')) return '无法连接授权服务器，可能是网络代理未启动或连接被拒绝。'
  if (message.includes('ConnectTimeout') || message.includes('ETIMEDOUT') || message.includes('fetch failed')) return '连接授权服务器超时，请检查网络或代理后重试。'
  if (message.includes('尚未配置')) return message
  return message.replace(/^Error invoking remote method [^:]+:\s*Error:\s*/i, '') || '授权失败，请稍后重试。'
}

async function refreshLicenseStatus() {
  if (isLocalDevelopment) {
    licenseStatus.value = { state: 'authorized', message: '本地开发模式' }
    return
  }
  try { licenseStatus.value = await window.phantomTowerLicense.getStatus() }
  catch { licenseStatus.value = { state: 'needs_activation', message: '无法读取本机授权状态' } }
}
async function activateLicense() {
  activationError.value = ''
  activating.value = true
  try {
    if (!desktopLicense?.activate) throw new Error('授权模块未加载，请使用桌面客户端安装包启动。')
    licenseStatus.value = await desktopLicense.activate(licenseKey.value)
    licenseKey.value = ''
  } catch (error) {
    activationError.value = friendlyActivationError(error)
  } finally { activating.value = false }
}

onMounted(() => { refreshLicenseStatus(); refreshApiProfiles() })
let licenseCheckTimer
onMounted(() => {
  if (isLocalDevelopment || !desktopLicense?.getStatus) return
  const minutes = Number(desktopLicense.checkIntervalMinutes || 5)
  licenseCheckTimer = window.setInterval(async () => {
    if (!isAuthorized.value) return
    try {
      const status = await desktopLicense.getStatus()
      if (status.state !== 'authorized') licenseStatus.value = status
    } catch {
      // Keep the current authorization during transient network failures.
    }
  }, Math.max(1, minutes) * 60 * 1000)
})
onMounted(() => window.addEventListener('sample-factory-settings-changed', refreshApiProfiles))
onUnmounted(() => {
  window.clearInterval(licenseCheckTimer)
  window.removeEventListener('sample-factory-settings-changed', refreshApiProfiles)
})
</script>

<template>
  <section v-if="!isAuthorized" class="license-gate">
    <div class="license-panel">
      <div class="brand"><span class="mark">S</span><div><b>样片工厂</b><small>Sample Factory</small></div></div>
      <h1>激活授权</h1>
      <p>{{ licenseStatus.message }}</p>
      <form @submit.prevent="activateLicense">
        <label for="license-key">许可证</label>
        <input id="license-key" v-model.trim="licenseKey" :disabled="activating || licenseStatus.state === 'checking'" autocomplete="off" placeholder="PT-xxxxxxxx" />
        <p v-if="activationError" class="activation-error">{{ activationError }}</p>
        <button type="submit" :disabled="activating || licenseStatus.state === 'checking'">{{ activating ? '正在验证...' : '验证并激活' }}</button>
      </form>
    </div>
  </section>
  <header v-if="isAuthorized" class="sidebar" aria-label="主导航">
    <div class="brand"><span class="mark">S</span><div><b>样片工厂</b><small>Sample Factory</small></div></div>
    <nav aria-label="功能导航">
      <RouterLink to="/"><Images :size="17" />创作工作台</RouterLink>
      <RouterLink to="/presets"><Settings2 :size="17" />提示词预设</RouterLink>
      <RouterLink to="/history"><History :size="17" />生成记录</RouterLink>
      <RouterLink to="/apis"><Server :size="17" />API 管理</RouterLink>
    </nav>
    <div class="sidebar-meta api-switcher">
      <button type="button" class="api-switcher-button" :disabled="apiSwitching" @click="showApiMenu = !showApiMenu">
        <span class="status-light"></span>
        <div><b>{{ activeApi?.name || '未选择工作台' }}</b><small>{{ apiSwitching ? '正在切换工作台...' : (apiSwitchError || 'Desktop workspace') }}</small></div>
        <ChevronDown :size="14" />
      </button>
      <div v-if="showApiMenu" class="api-switcher-menu">
        <button v-for="item in apiProfiles" :key="item.id" type="button" :class="{ active: item.id === activeApiId }" @click="selectApi(item.id)">
          <b>{{ item.name }}</b><small>{{ item.endpoint }}</small>
        </button>
        <RouterLink to="/apis" @click="showApiMenu = false">管理工作台配置</RouterLink>
      </div>
    </div>
  </header>
  <main v-if="isAuthorized">
    <RouterView v-slot="{ Component }">
      <KeepAlive>
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
  </main>
</template>

<style scoped>
.license-gate { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 24px; background: #f1eee7; }
.license-panel { width: min(100%, 420px); padding: 32px; border: 1px solid #d5cec1; background: #fffdf8; box-shadow: 0 18px 48px rgb(42 37 29 / 14%); }
.license-panel h1 { margin: 32px 0 8px; font-size: 24px; }
.license-panel p { color: #696154; line-height: 1.6; }
.license-panel form { display: grid; gap: 10px; margin-top: 24px; }
.license-panel label { font-size: 14px; font-weight: 700; color: #38342d; }
.license-panel input { box-sizing: border-box; width: 100%; height: 42px; border: 1px solid #bdb4a4; padding: 0 12px; font: inherit; }
.license-panel button { height: 42px; border: 0; background: #27241f; color: #fff; font: inherit; cursor: pointer; }
.license-panel button:disabled, .license-panel input:disabled { cursor: wait; opacity: .6; }
.activation-error { margin: 0; color: #b42318 !important; font-size: 13px; }
</style>
