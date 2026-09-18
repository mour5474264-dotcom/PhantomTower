<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'

const loading = ref(true)
const loadError = ref(false)
const frame = ref(null)
const router = useRouter()
function openApiSettings(event) {
  if (event.origin !== window.location.origin || event.source !== frame.value?.contentWindow) return
  if (event.data?.type === 'phantom-tower:open-api-settings') router.push('/apis')
}
onMounted(() => window.addEventListener('message', openApiSettings))
onBeforeUnmount(() => window.removeEventListener('message', openApiSettings))

function canvasLoaded() {
  loading.value = false
}

function canvasLoadFailed() {
  loading.value = false
  loadError.value = true
}
</script>

<template>
  <section class="canvas-host" aria-label="无限画布">
    <div v-if="loading" class="canvas-loading" role="status">正在打开无限画布…</div>
    <iframe
      ref="frame"
      class="canvas-frame"
      src="./canvas.html#/canvas"
      title="无限画布"
      @load="canvasLoaded"
      @error="canvasLoadFailed"
    ></iframe>
    <div v-if="loadError" class="canvas-mount-error">无限画布加载失败，请重新打开页面。</div>
  </section>
</template>

<style scoped>
.canvas-host { position: fixed; inset: 58px 0 0; z-index: 1; min-height: calc(100vh - 58px); background: #f4f6f2; }
.canvas-frame { display: block; width: 100%; height: 100%; border: 0; background: #f4f6f2; }
.canvas-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; color: #68756e; font: 13px sans-serif; background: #f4f6f2; }
.canvas-mount-error { padding: 24px; color: #b42318; font-family: sans-serif; }
</style>
