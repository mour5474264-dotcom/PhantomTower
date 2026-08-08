<script setup>
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Edit3 } from 'lucide-vue-next'
import { getPresets, savePresets } from '../api'
const presets = ref([]); const dialog = ref(false); const editingId = ref(''); const form = ref({ name: '', prompt: '' })
function openCreate() { editingId.value = ''; form.value = { name: '', prompt: '' }; dialog.value = true }
function edit(item) { editingId.value = item.id; form.value = { ...item }; dialog.value = true }
async function submit() { if (!form.value.name || !form.value.prompt) return; if (editingId.value) Object.assign(presets.value.find((item) => item.id === editingId.value), form.value); else presets.value.push({ id: crypto.randomUUID(), ...form.value }); await savePresets(presets.value); dialog.value = false }
async function remove(id) { presets.value = presets.value.filter((item) => item.id !== id); await savePresets(presets.value) }
onMounted(async () => { presets.value = await getPresets() })
</script>
<template>
  <section class="page"><div class="page-heading"><div><span class="eyebrow">PRESETS / PROMPT LIBRARY</span><h2>提示词预设</h2><p class="muted">创建可复用的公共提示词，工作台只选择已保存的预设。</p></div></div>
    <div class="panel preset-list admin-table"><div class="list-head"><div><h3>预设列表</h3><span class="muted">共 {{ presets.length }} 个预设</span></div><el-button type="primary" :icon="Plus" @click="openCreate">新增预设</el-button></div><el-table v-if="presets.length" :data="presets" stripe><el-table-column type="index" label="#" width="64" /><el-table-column prop="name" label="预设名称" min-width="220" /><el-table-column prop="prompt" label="公共提示词" min-width="520" show-overflow-tooltip /><el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="edit(row)">编辑</el-button><el-button link type="danger" @click="remove(row.id)">删除</el-button></template></el-table-column></el-table><el-empty v-else description="暂无提示词预设" /></div>
    <el-dialog v-model="dialog" :title="editingId ? '编辑提示词预设' : '新增提示词预设'" width="560px"><el-form label-position="top"><el-form-item label="预设名称"><el-input v-model="form.name" /></el-form-item><el-form-item label="公共提示词"><el-input v-model="form.prompt" type="textarea" :rows="6" /></el-form-item></el-form><template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" @click="submit">保存预设</el-button></template></el-dialog>
  </section>
</template>
