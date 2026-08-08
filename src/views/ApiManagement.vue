<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Plus, Trash2, CheckCircle2, Wifi, Edit3 } from 'lucide-vue-next'
import { getSettings, saveSettings, getModels } from '../api'

const profiles = ref([])
const activeId = ref('')
const dialog = ref(false)
const editingId = ref('')
const status = ref('')
const testing = ref(false)
const balance = ref({})
const blank = () => ({ name: '', endpoint: 'https://example.com/v1', key: '', model: '' })
const form = ref(blank())

async function persist() { await saveSettings({ apis: profiles.value, activeApiId: activeId.value }) }
function openCreate() { editingId.value = ''; form.value = blank(); dialog.value = true }
function openEdit(item) { editingId.value = item.id; form.value = { ...item }; dialog.value = true }
async function submit() {
  if (!form.value.name || !form.value.endpoint || !form.value.key) return
  if (editingId.value) Object.assign(profiles.value.find((item) => item.id === editingId.value), form.value)
  else { const item = { ...form.value, id: crypto.randomUUID() }; profiles.value.push(item); activeId.value = item.id }
  await persist(); dialog.value = false; status.value = '配置已保存'
}
async function remove(id) { profiles.value = profiles.value.filter((item) => item.id !== id); if (activeId.value === id) activeId.value = profiles.value[0]?.id || ''; await persist() }
async function activate(id) { activeId.value = id; await persist() }
async function test(item) { testing.value = true; activeId.value = item.id; await persist(); try { const models = await getModels(); ElMessage.success(`连接成功，读取到 ${models.length} 个模型`) } catch (e) { ElMessage.error(`连接失败：${e.message}`) } finally { testing.value = false } }
async function queryBalance(item) { balance.value[item.id] = '查询中'; try { const response = await fetch(`http://127.0.0.1:4317/api/balance?apiId=${encodeURIComponent(item.id)}`); const data = await response.json(); balance.value[item.id] = data.balance ?? data.total_available ?? data.error ?? '暂无数据' } catch (e) { balance.value[item.id] = e.message } }
getSettings().then((data) => { profiles.value = data.apis || []; activeId.value = data.activeApiId || '' }).catch((e) => { status.value = e.message })
</script>

<template>
  <section class="page api-page">
    <div class="page-heading"><div><span class="eyebrow">CONNECTIONS / API</span><h2>API 管理</h2><p class="muted">管理中转站连接，切换后工作台会读取对应模型。</p></div></div>
    <el-alert v-if="status" :title="status" type="info" :closable="false" class="page-alert" />
    <div class="panel api-list admin-table"><div class="list-head"><div><h3>中转站列表</h3><span class="muted">共 {{ profiles.length }} 个配置</span></div><el-button type="primary" :icon="Plus" @click="openCreate">新增中转站</el-button></div><el-table v-if="profiles.length" :data="profiles" stripe><el-table-column type="index" label="#" width="64" /><el-table-column prop="name" label="中转站名称" min-width="180" /><el-table-column prop="endpoint" label="接口地址" min-width="280" show-overflow-tooltip /><el-table-column label="默认模型" min-width="160"><template #default="{ row }">{{ row.model || '自动读取' }}</template></el-table-column><el-table-column label="启用" width="100"><template #default="{ row }"><el-switch :model-value="activeId === row.id" @change="activate(row.id)" /></template></el-table-column><el-table-column label="余额" width="140"><template #default="{ row }">{{ balance[row.id] || '未查询' }}</template></el-table-column><el-table-column label="操作" width="290" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="queryBalance(row)">查询余额</el-button><el-button link @click="test(row)">测试连接</el-button><el-button link @click="openEdit(row)">编辑</el-button><el-button link type="danger" @click="remove(row.id)">删除</el-button></template></el-table-column></el-table><el-empty v-else description="暂无中转站配置，请点击新增中转站" /></div>
    <el-dialog v-model="dialog" :title="editingId ? '编辑中转站' : '新增中转站'" width="520px"><el-form label-position="top"><el-form-item label="名称"><el-input v-model="form.name" /></el-form-item><el-form-item label="Endpoint"><el-input v-model="form.endpoint" /></el-form-item><el-form-item label="API Key"><el-input v-model="form.key" type="password" show-password /></el-form-item><el-form-item label="默认模型（可选）"><el-input v-model="form.model" /></el-form-item></el-form><template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" @click="submit">保存配置</el-button></template></el-dialog>
  </section>
</template>
