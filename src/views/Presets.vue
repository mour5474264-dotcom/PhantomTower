<script setup>
import {computed, ref, onMounted} from 'vue'
import {ElMessage, ElMessageBox} from 'element-plus'
import {Plus, RotateCcw, Copy} from 'lucide-vue-next'
import {getPromptTemplates, savePromptTemplates, getBuiltInPromptTemplates, saveBuiltInPromptTemplates, restoreDefaultBuiltInPromptTemplates, notifyPromptTemplatesChanged} from '../api'

const activeTab = ref('user')
const templates = ref([])
const dialog = ref(false)
const editingId = ref('')
const form = ref({name: '', systemPrompt: '', defaultNegativePrompt: ''})
const formRef = ref()
const requiredRule = (message) => ({
  required: true,
  whitespace: true,
  message,
  trigger: ['blur', 'change']
})
const formRules = computed(() => ({
  name: [requiredRule('请输入预设名称')],
  systemPrompt: [requiredRule(isBuiltIn.value ? '请输入内置提示词' : '请输入提示词内容')]
}))

const isBuiltIn = computed(() => activeTab.value === 'builtin')
const title = computed(() => isBuiltIn.value ? '内置提示词预设' : '提示词预设')
const description = computed(() => isBuiltIn.value
  ? '内置预设会根据创作台当前功能自动生效，不会在创作台显示。'
  : '保存可重复使用的创作提示词；创作台的所有模式均可按需选择。')

async function loadTemplates() {
  try {
    templates.value = isBuiltIn.value ? await getBuiltInPromptTemplates() : await getPromptTemplates()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

function changeTab(tab) {
  activeTab.value = tab
  loadTemplates()
}

function openCreate() {
  editingId.value = ''
  form.value = {name: '', systemPrompt: '', defaultNegativePrompt: ''}
  dialog.value = true
}

function edit(item) {
  editingId.value = item.id
  form.value = {name: item.name, systemPrompt: item.systemPrompt, defaultNegativePrompt: item.defaultNegativePrompt || ''}
  dialog.value = true
}

function copyTemplate(item) {
  editingId.value = ''
  form.value = {name: `${item.name} 副本`, systemPrompt: item.systemPrompt, defaultNegativePrompt: item.defaultNegativePrompt || ''}
  dialog.value = true
}

async function save() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  const next = templates.value.map((item) => ({...item}))
  const existingTemplate = next.find((item) => item.id === editingId.value)
  const template = isBuiltIn.value
    ? {...form.value, mode: existingTemplate?.mode || 'text', operation: existingTemplate?.operation || 'text'}
    : {...form.value, mode: 'all', operation: 'all'}
  if (editingId.value) Object.assign(existingTemplate, template)
  else next.push({id: crypto.randomUUID(), ...template})
  try {
    templates.value = isBuiltIn.value ? await saveBuiltInPromptTemplates(next) : await savePromptTemplates(next)
    if (!isBuiltIn.value) notifyPromptTemplatesChanged()
    dialog.value = false
    ElMessage.success('预设已保存')
  } catch (error) { ElMessage.error(error.message) }
}

async function remove(id) {
  try {
    await ElMessageBox.confirm('删除后将无法在创作台使用该预设。', '确认删除', {type: 'warning'})
    const next = templates.value.filter((item) => item.id !== id)
    templates.value = isBuiltIn.value ? await saveBuiltInPromptTemplates(next) : await savePromptTemplates(next)
    if (!isBuiltIn.value) notifyPromptTemplatesChanged()
    ElMessage.success('预设已删除')
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message) }
}

async function restoreDefaults() {
  if (!isBuiltIn.value) return
  try {
    await ElMessageBox.confirm('恢复出厂预设会覆盖当前所有内置提示词预设。', '恢复默认设置', {type: 'warning'})
    templates.value = await restoreDefaultBuiltInPromptTemplates()
    ElMessage.success('已恢复内置提示词预设')
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message) }
}

onMounted(async () => {
  await loadTemplates()
})
</script>

<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <span class="eyebrow">提示词管理</span>
        <h2>提示词预设</h2>
        <p class="muted">{{ description }}</p>
      </div>
    </div>
    <el-tabs v-model="activeTab" class="preset-tabs" @tab-change="changeTab">
      <el-tab-pane label="提示词预设" name="user"/>
      <el-tab-pane label="内置提示词预设" name="builtin"/>
    </el-tabs>
    <div class="panel preset-list admin-table">
      <div class="list-head">
        <div><h3>{{ title }}</h3><span class="muted">共 {{ templates.length }} 个预设</span></div>
        <div>
          <el-button v-if="isBuiltIn" :icon="RotateCcw" @click="restoreDefaults">恢复默认</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">新增预设</el-button>
        </div>
      </div>
      <el-table v-if="templates.length" :data="templates" stripe>
        <el-table-column type="index" label="#" width="64"/>
        <el-table-column prop="name" label="预设名称" min-width="180"/>
        <el-table-column prop="systemPrompt" label="提示词内容" min-width="330" show-overflow-tooltip/>
        <el-table-column label="操作" width="190" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="edit(row)">编辑</el-button>
            <el-button link @click="copyTemplate(row)">复制</el-button>
            <el-button link type="danger" @click="remove(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else :description="isBuiltIn ? '尚未配置内置提示词预设' : '暂无提示词预设'"/>
    </div>
    <el-dialog v-model="dialog" :title="editingId ? `编辑${title}` : `新增${title}`" width="680px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-position="top">
        <el-form-item label="预设名称" prop="name" required><el-input v-model="form.name"/></el-form-item>
        <el-form-item :label="isBuiltIn ? '内置提示词' : '提示词内容'" prop="systemPrompt" required><el-input v-model="form.systemPrompt" type="textarea" :rows="6"/></el-form-item>
        <el-form-item label="默认负向提示词（可选）"><el-input v-model="form.defaultNegativePrompt" type="textarea" :rows="3"/></el-form-item>
      </el-form>
      <template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" @click="save">保存</el-button></template>
    </el-dialog>
  </section>
</template>

