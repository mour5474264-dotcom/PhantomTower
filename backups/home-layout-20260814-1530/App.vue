<script setup>
import { computed, ref } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { Images, Library, Settings2, History, Server, ChevronDown } from 'lucide-vue-next'

const apiProfiles = ref(JSON.parse(localStorage.getItem('atelier-apis') || '[]'))
const activeApiId = ref(localStorage.getItem('atelier-active-api') || '')
const showApiMenu = ref(false)
const activeApi = computed(() => apiProfiles.value.find((item) => item.id === activeApiId.value))
function selectApi(id) { activeApiId.value = id; localStorage.setItem('atelier-active-api', id); showApiMenu.value = false }
</script>

<template>
  <aside class="sidebar">
    <div class="brand"><span class="mark">S</span><div><b>样片工厂</b><small>Sample Factory</small></div></div>
    <nav>
      <RouterLink to="/"><Images :size="17" />创作工作台</RouterLink>
      <RouterLink to="/library"><Library :size="17" />素材库</RouterLink>
      <RouterLink to="/presets"><Settings2 :size="17" />提示词预设</RouterLink>
      <RouterLink to="/history"><History :size="17" />生成记录</RouterLink>
      <RouterLink to="/apis"><Server :size="17" />API 管理</RouterLink>
    </nav>
    <div class="sidebar-meta"><span class="status-light"></span><div><b>LOCAL STUDIO</b><small>Desktop workspace</small></div></div>
  </aside>
  <main>
    <RouterView v-slot="{ Component }">
      <KeepAlive>
        <component :is="Component" />
      </KeepAlive>
    </RouterView>
  </main>
</template>
