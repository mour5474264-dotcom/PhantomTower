<script setup>
import {onMounted, ref} from 'vue'
import {ElMessage, ElMessageBox} from 'element-plus'
import {Plus, Trash2, CheckCircle2, Wifi, Edit3, FileText, RefreshCw, Eye} from 'lucide-vue-next'
import {getSettings, saveSettings, testApiConnection, getGenerationLogsPage, deleteAllGenerationLogs, notifyActiveApiChanged, formatApiError} from '../api'

const profiles = ref([])
const activeId = ref('')
const dialog = ref(false)
const editingId = ref('')
const status = ref('')
const advancedRoutes = ref(false)
const detectedProtocols = ref([])
const ambiguousModels = ref([])
const testingId = ref('')
const generationLogs = ref([])
const logsDialog = ref(false)
const logsProfile = ref(null)
const detailDialog = ref(false)
const selectedLog = ref(null)
const logsLoading = ref(false)
const logTotal = ref(0)
const logFilters = ref({dateRange: [], page: 1, pageSize: 20})
function formatChinaTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date).replace(/\//g, '-')
}
const blank = () => ({name: '', endpoint: '', key: '', provider: '', models: []})
const form = ref(blank())
const modelDraft = ref({name: '', modelName: '', protocol: ''})
const formRef = ref()
const requiredRule = (message) => ({
  required: true,
  whitespace: true,
  message,
  trigger: ['blur', 'change']
})
const formRules = {
  name: [requiredRule('请输入名称')],
  endpoint: [requiredRule('请输入地址')],
  key: []
}

const profileLogs = () => {
  const profile = logsProfile.value
  if (!profile) return []
  return generationLogs.value.filter((log) => log.apiId === profile.id
    || (!log.apiId && String(log.modelConfigId || '').startsWith(`${profile.id}:`))
    || (!log.apiId && log.upstreamName === profile.name))
}

function modelDisplayName(log, profile = logsProfile.value) {
  if (log?.modelDisplayName && log.modelDisplayName !== log.model) return log.modelDisplayName
  const modelId = String(log?.model || '')
  const configId = String(log?.configuredModelId || modelId.split(':').pop())
  const model = (profile?.models || []).find((item) => item.id === configId || item.modelName === modelId)
  return model?.name || log?.modelDisplayName || model?.modelName || modelId || '-'
}

function statusLabel(log) {
  if (log?.status === 'success-response') return '成功'
  if (log?.status === 'upstream-error' || log?.status === 'upstream-response-error' || log?.status === 'network-error') return '错误'
  if (log?.status === 'headers-received') return '已收到响应'
  if (log?.status === 'dispatching') return '处理中'
  return log?.status || '-'
}

function statusType(log) {
  if (log?.status === 'success-response') return 'success'
  if (log?.status === 'upstream-error' || log?.status === 'upstream-response-error' || log?.status === 'network-error') return 'danger'
  if (log?.status === 'headers-received') return 'warning'
  return 'info'
}

function logDetail(log) {
  if (!log) return '-'
  if (log.error) return log.error
  if (log.upstreamBody) return log.upstreamBody
  if (log.upstreamRequestId) return `上游请求 ID：${log.upstreamRequestId}`
  if (log.upstream) return typeof log.upstream === 'string' ? log.upstream : JSON.stringify(log.upstream)
  if (log.status === 'headers-received') return `已收到上游响应头（HTTP ${log.httpStatus || '-'}），响应内容尚未完整读取`
  return log.requestId || '-'
}

function logCost(log) {
  const values = [log?.cost, log?.price, log?.usage?.cost, log?.usage?.total_cost, log?.usage?.totalCost, log?.usageMetadata?.cost]
  const value = values.find((item) => item !== undefined && item !== null && item !== '')
  if (value === undefined) return '未提供'
  const number = Number(value)
  return Number.isFinite(number) ? `$${number.toFixed(number < 0.01 ? 4 : 2)}` : String(value)
}

function logTokens(log) {
  const usage = log?.usage || log?.usageMetadata
  if (!usage) return '-'
  const input = usage.input_tokens ?? usage.promptTokenCount
  const output = usage.output_tokens ?? usage.candidatesTokenCount
  return input !== undefined || output !== undefined ? `${input ?? 0} / ${output ?? 0}` : '-'
}

async function openLogs(profile) {
  logsProfile.value = profile
  logsDialog.value = true
  logFilters.value = {dateRange: [], page: 1, pageSize: 20}
  await refreshLogs()
}

function openLogDetail(log) {
  selectedLog.value = log
  detailDialog.value = true
}

async function refreshLogs() {
  if (!logsProfile.value) return
  logsLoading.value = true
  try {
    const [startTime, endTime] = logFilters.value.dateRange || []
    const result = await getGenerationLogsPage({
      apiId: logsProfile.value.id,
      upstreamName: logsProfile.value.name,
      startTime,
      endTime,
      page: logFilters.value.page,
      pageSize: logFilters.value.pageSize
    })
    generationLogs.value = result.data || []
    logTotal.value = Number(result.total || 0)
  } catch (error) {
    ElMessage.error(formatApiError(error, '调用日志读取失败'))
  } finally {
    logsLoading.value = false
  }
}

function searchLogs() {
  logFilters.value.page = 1
  refreshLogs()
}

function clearLogFilters() {
  logFilters.value.dateRange = []
  searchLogs()
}

function changeLogPage(page) {
  logFilters.value.page = page
  refreshLogs()
}

function changeLogPageSize(size) {
  logFilters.value.pageSize = size
  logFilters.value.page = 1
  refreshLogs()
}

async function clearLogs() {
  if (!logTotal.value) return
  try {
    await ElMessageBox.confirm(`将删除“${logsProfile.value?.name || '当前中转站'}”的全部调用日志，其他中转站、生成记录和图片文件不会受影响。此操作无法撤销。`, '删除当前中转站日志', {
      type: 'warning',
      confirmButtonText: '删除全部',
      cancelButtonText: '取消'
    })
    const result = await deleteAllGenerationLogs({apiId: logsProfile.value?.id, upstreamName: logsProfile.value?.name})
    generationLogs.value = []
    logTotal.value = 0
    ElMessage.success(`已删除 ${result.count || 0} 条调用日志`)
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error(formatApiError(error, '调用日志删除失败'))
  }
}

async function persist() {
  await saveSettings({apis: profiles.value, activeApiId: activeId.value})
  const settings = await getSettings()
  profiles.value = settings.apis || []
  activeId.value = settings.activeApiId || ''
  notifyActiveApiChanged(activeId.value)
  window.dispatchEvent(new CustomEvent('sample-factory-settings-changed'))
}

function openCreate() {
  editingId.value = '';
  form.value = blank();
  modelDraft.value = {name: '', modelName: '', protocol: ''}
  advancedRoutes.value = false
  detectedProtocols.value = []
  ambiguousModels.value = []
  dialog.value = true
}

function openEdit(item) {
  editingId.value = item.id;
  form.value = {...item, key: '', models: Array.isArray(item.models) ? item.models.map((model) => ({...model})) : []};
  modelDraft.value = {name: '', modelName: '', protocol: item.detectedRoute?.protocol || ''}
  advancedRoutes.value = false
  detectedProtocols.value = item.detectedProtocols || (item.detectedRoute ? [item.detectedRoute.protocol] : [])
  ambiguousModels.value = item.ambiguousModels || []
  dialog.value = true
}

function protocolForProvider(provider) {
  if (provider === 'gemini') return 'gemini-generate-content'
  if (provider === 'anthropic') return 'anthropic-messages'
  if (provider === 'mj') return 'mj-proxy'
  return 'openai-images'
}

function applyProviderToModels(provider) {
  const protocol = protocolForProvider(provider)
  const route = form.value.detectedRoute || {}
  form.value.models = form.value.models.map((model) => ({
    ...model,
    provider,
    protocol,
    routeSource: 'manual',
    routeKey: `${protocol}:${model.modelName}`,
    imagePath: protocol === 'gemini-generate-content' ? '' : (route.imagePath || '/images/generations'),
    editPath: protocol === 'gemini-generate-content' ? '' : (route.editPath || '/images/edits'),
    authType: protocol === 'gemini-generate-content' ? 'query-key' : (protocol === 'anthropic-messages' ? 'x-api-key' : (route.authType || 'bearer'))
  }))
  modelDraft.value.protocol = protocol
}

function updateModelProtocol(model, protocol) {
  const provider = protocol.startsWith('gemini') ? 'gemini'
    : protocol.startsWith('anthropic') ? 'anthropic'
      : protocol === 'mj-proxy' ? 'mj' : 'openai'
  const route = form.value.detectedRoute || {}
  Object.assign(model, {
    provider,
    protocol,
    routeSource: 'manual',
    routeKey: `${protocol}:${model.modelName}`,
    imagePath: protocol === 'gemini-generate-content' ? '' : (route.imagePath || '/images/generations'),
    editPath: protocol === 'gemini-generate-content' ? '' : (route.editPath || '/images/edits'),
    authType: protocol === 'gemini-generate-content' ? 'query-key' : (protocol === 'anthropic-messages' ? 'x-api-key' : (route.authType || 'bearer'))
  })
}

async function submit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  if (!editingId.value && !form.value.key.trim()) {
    ElMessage.error('请输入 API Key')
    return
  }
  if (modelDraft.value.modelName?.trim() && !form.value.models.some((item) => item.modelName === modelDraft.value.modelName.trim() && item.protocol === protocolForProvider(form.value.provider))) {
    addModel()
  }
  if (editingId.value) {
    const target = profiles.value.find((item) => item.id === editingId.value)
    Object.assign(target, {...form.value, key: form.value.key || undefined})
  }
  else {
    const item = {...form.value, id: crypto.randomUUID()};
    profiles.value.push(item);
    activeId.value = item.id
  }
  try {
    await persist();
    dialog.value = false;
    status.value = 'API 配置已保存';
    ElMessage.success(status.value)
  } catch (error) {
    ElMessage.error(formatApiError(error, 'API 配置保存失败'))
  }
}

function addModel() {
  const modelName = String(modelDraft.value.modelName || '').trim()
  if (!modelName) return ElMessage.error('请输入实际模型名称')
  const route = form.value.detectedRoute || {}
  const protocol = modelDraft.value.protocol || route.protocol || 'openai-images'
  const routeKey = `${protocol}:${modelName}`
  const existing = form.value.models.find((item) => item.routeKey === routeKey)
  const provider = protocol.startsWith('gemini') ? 'gemini'
    : protocol.startsWith('anthropic') ? 'anthropic'
      : protocol === 'mj-proxy' ? 'mj' : (form.value.provider || route.provider || 'openai')
  const next = {
    id: existing?.id || `model-${crypto.randomUUID()}`,
    name: String(modelDraft.value.name || modelName).trim(),
    modelName,
    provider,
    protocol,
    imagePath: protocol === 'gemini-generate-content' ? '' : (route.imagePath || '/images/generations'),
    editPath: protocol === 'gemini-generate-content' ? '' : (route.editPath || '/images/edits'),
    authType: protocol === 'gemini-generate-content' ? 'query-key' : (protocol === 'anthropic-messages' ? 'x-api-key' : (route.authType || 'bearer')),
    routeSource: 'manual',
    routeKey
  }
  if (existing) Object.assign(existing, next)
  else form.value.models.push(next)
  modelDraft.value = {name: '', modelName: '', protocol: next.protocol}
}

function removeModel(id) {
  form.value.models = form.value.models.filter((item) => item.id !== id)
}

async function remove(id) {
  profiles.value = profiles.value.filter((item) => item.id !== id);
  if (activeId.value === id) activeId.value = profiles.value[0]?.id || '';
  await persist()
}

async function activate(id) {
  const previous = activeId.value;
  activeId.value = id;
  try {
    await persist();
    ElMessage.success('已切换 API')
  } catch (error) {
    activeId.value = previous;
    ElMessage.error(formatApiError(error, 'API 切换失败'))
  }
}

async function test(item) {
  if (testingId.value) return
  testingId.value = item.id;
  try {
    const result = await testApiConnection(item);
    const models = result.models || []
    const detection = result.detection
    detectedProtocols.value = result.detections?.map((entry) => entry.protocol) || (detection ? [detection.protocol] : [])
    ambiguousModels.value = result.ambiguousModels || []
    const protocol = detection?.protocol || item.provider || 'openai-images'
    ElMessage.success(`连接成功，识别为 ${protocol}，读取到 ${models.length} 个模型`)
    // The server persists the merged route table. Reload it instead of saving
    // the stale renderer copy back over the newly detected configurations.
    const refreshed = await getSettings()
    profiles.value = refreshed.apis || []
    activeId.value = refreshed.activeApiId || ''
    notifyActiveApiChanged(activeId.value)
    window.dispatchEvent(new CustomEvent('sample-factory-settings-changed'))
  } catch (e) {
    ElMessage.error(`连接失败：\n${formatApiError(e, '连接测试失败')}`)
  } finally {
    testingId.value = ''
  }
}

onMounted(async () => {
  try {
    const settings = await getSettings()
    profiles.value = settings.apis || []
    activeId.value = settings.activeApiId || ''
  } catch (error) {
    ElMessage.error(formatApiError(error, 'API 配置读取失败'))
  }
})
</script>

<template>
  <section class="page api-page">
    <div class="page-heading">
      <div><span class="eyebrow">CONNECTIONS / API</span>
        <h2>API 管理</h2>
        </div>
    </div>
    <el-alert v-if="status" :title="status" type="info" :closable="false" class="page-alert"/>
    <div class="panel api-list admin-table">
      <div class="list-head">
        <div><h3>中转站列表</h3><span class="muted">共 {{ profiles.length }} 个配置</span></div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增中转站</el-button>
      </div>
      <el-table v-if="profiles.length" :data="profiles" stripe>
        <el-table-column type="index" label="#" width="64"/>
        <el-table-column prop="name" label="中转站名称" min-width="180"/>
        <el-table-column prop="endpoint" label="接口地址" min-width="280" show-overflow-tooltip/>
        <el-table-column label="默认模型" min-width="160">
          <template #default="{ row }">{{ row.model || '自动读取' }}</template>
        </el-table-column>
        <el-table-column label="模型配置" min-width="120">
          <template #default="{ row }">{{ row.models?.length || 0 }} 个</template>
        </el-table-column>
        <el-table-column label="启用" width="100">
          <template #default="{ row }">
            <el-switch :model-value="activeId === row.id" @change="activate(row.id)"/>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="360" fixed="right">
          <template #default="{ row }">
            <el-button link :icon="FileText" @click="openLogs(row)">调用日志</el-button>
            <el-button link :loading="testingId === row.id" :disabled="Boolean(testingId)" @click="test(row)">测试连接</el-button>
            <el-button link @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row.id)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="暂无中转站配置，请点击新增中转站"/>
    </div>
    <el-dialog v-model="logsDialog" :title="`${logsProfile?.name || ''} · 最近调用日志`" width="1120px" top="6vh" class="logs-dialog">
      <div class="logs-toolbar">
        <div class="logs-filters">
          <el-date-picker v-model="logFilters.dateRange" type="datetimerange" format="YYYY年MM月DD日 HH:mm" value-format="YYYY-MM-DD HH:mm:ss" range-separator="至" start-placeholder="开始日期时间" end-placeholder="结束日期时间" clearable @change="searchLogs" />
          <el-button type="primary" @click="searchLogs">搜索</el-button>
          <el-button @click="clearLogFilters">重置</el-button>
        </div>
        <div class="logs-toolbar-actions">
          <el-button text type="danger" :icon="Trash2" :disabled="!logTotal" @click="clearLogs">删除全部历史</el-button>
        </div>
      </div>
      <el-table v-if="generationLogs.length" v-loading="logsLoading" :data="generationLogs" stripe max-height="560" class="logs-table">
        <el-table-column label="时间" width="170">
          <template #default="{row}">{{ formatChinaTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="模型" min-width="180">
          <template #default="{row}"><span class="model-name">{{ modelDisplayName(row) }}</span></template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{row}"><el-tag :type="statusType(row)" effect="light">{{ statusLabel(row) }}<template v-if="row.httpStatus"> · {{ row.httpStatus }}</template></el-tag></template>
        </el-table-column>
        <el-table-column label="耗时" width="110">
          <template #default="{row}">{{ row.durationMs ? `${(row.durationMs / 1000).toFixed(1)}s` : '-' }}</template>
        </el-table-column>
        <el-table-column label="Tokens" width="130">
          <template #default="{row}">{{ logTokens(row) }}</template>
        </el-table-column>

        <el-table-column label="详情" min-width="250" >
          <template #default="{row}" >
            <span class="log-detail" :class="{ 'is-error': statusType(row) === 'danger' }">{{ logDetail(row) }}</span>
            <el-button text :icon="Eye" class="detail-button" @click="openLogDetail(row)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else-if="!logsLoading" description="暂无符合条件的调用日志"/>
      <div class="logs-pagination" v-if="logTotal">
        <el-pagination background layout="total, sizes, prev, pager, next" :total="logTotal" :current-page="logFilters.page" :page-size="logFilters.pageSize" :page-sizes="[10, 20, 50, 100]" @current-change="changeLogPage" @size-change="changeLogPageSize" />
      </div>
    </el-dialog>
    <el-dialog v-model="detailDialog" title="调用详情" width="680px">
      <div v-if="selectedLog" class="log-detail-dialog">
        <div class="detail-meta"><span>{{ modelDisplayName(selectedLog) }}</span><el-tag :type="statusType(selectedLog)">{{ statusLabel(selectedLog) }}</el-tag></div>
        <pre>{{ logDetail(selectedLog) }}</pre>
        <div class="detail-grid">
          <span>请求 ID</span><b>{{ selectedLog.requestId || '-' }}</b>
          <span>接口地址</span><b>{{ selectedLog.endpoint || '-' }}</b>
          <span>耗时</span><b>{{ selectedLog.durationMs ? `${(selectedLog.durationMs / 1000).toFixed(1)} 秒` : '-' }}</b>
          <span>费用</span><b>{{ logCost(selectedLog) }}</b>
        </div>
      </div>
    </el-dialog>
    <el-dialog v-model="dialog" :title="editingId ? '编辑中转站' : '新增中转站'" width="520px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-position="top">
        <el-form-item label="名称" prop="name" required>
          <el-input v-model="form.name" placeholder="输入名称如：主力"/>
        </el-form-item>
        <el-form-item label="地址" prop="endpoint" required>
          <el-input v-model="form.endpoint" placeholder="请输入网站地址，如：https://chatgpt.com（无需填写 /v1 或接口路径）"/>
        </el-form-item>
        <el-form-item label="API Key" prop="key" :required="!editingId">
          <el-input v-model="form.key" type="password" show-password :placeholder="editingId ? '留空表示保持当前密钥不变' : '请输入对应网址的apiKey'"/>
        </el-form-item>
        <el-form-item label="协议">
          <el-select v-model="form.provider" placeholder="请选择中转协议" style="width: 100%" @change="applyProviderToModels">
            <el-option label="OpenAI 兼容协议" value="openai" />
            <el-option label="Anthropic Messages 协议" value="anthropic" />
            <el-option label="Google Gemini 原生协议" value="gemini" />
            <el-option label="Midjourney Proxy" value="mj" />
          </el-select>
        </el-form-item>
        <div class="advanced-toggle"><span>高级路由</span><el-switch v-model="advancedRoutes" /></div>
        <div v-if="advancedRoutes" class="advanced-routes-panel">
          <div class="route-mode-bar">
            <div><strong>自动配置模型</strong><p>测试连接后会自动读取可用模型和连接方式。</p></div>
          </div>
          <div class="model-quick-row">
            <el-select v-model="modelDraft.modelName" filterable allow-create default-first-option clearable placeholder="选择或输入模型 ID（可选）">
              <el-option v-for="model in form.models" :key="model.id" :label="model.name || model.modelName" :value="model.modelName" />
            </el-select>
            <el-button :icon="Plus" @click="addModel">添加模型</el-button>
          </div>
          <el-alert v-if="detectedProtocols.length" type="success" :closable="false" class="route-detection-alert">
            已识别 {{ detectedProtocols.length }} 种连接方式：{{ detectedProtocols.join('、') }}<span v-if="ambiguousModels.length">；{{ ambiguousModels.length }} 个模型存在多种连接方式</span>
          </el-alert>
          <el-divider content-position="left">模型路由</el-divider>
          <div class="model-editor-row">
            <el-input v-model="modelDraft.name" placeholder="显示名称（可选）" />
            <span class="advanced-hint">模型协议统一使用上方选择；需要不同协议时可在下方编辑路由。</span>
          </div>
        <el-table v-if="form.models.length" :data="form.models" size="small" class="model-editor-table">
          <el-table-column prop="name" label="显示名称" min-width="120" />
          <el-table-column prop="modelName" label="实际模型 ID" min-width="180" />
          <el-table-column label="请求协议" min-width="190">
            <template #default="{ row }">
              <el-select :model-value="row.protocol" size="small" @update:model-value="updateModelProtocol(row, $event)">
                <el-option label="OpenAI Images" value="openai-images" />
                <el-option label="OpenAI Chat 图片" value="openai-chat" />
                <el-option label="Gemini Generate Content" value="gemini-generate-content" />
                <el-option label="Anthropic Messages" value="anthropic-messages" />
                <el-option label="MJ Proxy" value="mj-proxy" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="70">
            <template #default="{ row }"><el-button link type="danger" @click="removeModel(row.id)">删除</el-button></template>
          </el-table-column>
        </el-table>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="submit">保存配置</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.route-mode-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;margin:4px 0 12px;background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:6px}.route-mode-bar strong{display:block;color:var(--el-text-color-primary);font-size:14px}.route-mode-bar p{margin:4px 0 0;color:var(--el-text-color-secondary);font-size:12px}.route-detection-alert{margin-bottom:12px}.route-detection-alert :deep(.el-alert__content){line-height:1.5}
.advanced-toggle{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:4px 0 12px;color:var(--el-text-color-regular);font-size:13px}.advanced-routes-panel{padding-top:2px}
.model-quick-row{display:flex;gap:8px;margin:2px 0 12px}.model-quick-row .el-input{flex:1}.advanced-hint{grid-column:2 / -1;color:var(--el-text-color-secondary);font-size:12px;line-height:32px}
.model-editor-row{display:grid;grid-template-columns:1fr 1.4fr 1.2fr auto;gap:8px;align-items:center;margin-bottom:10px}
.model-editor-table{margin-top:8px}
.logs-toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--el-border-color-lighter)}
.logs-filters{display:grid;grid-template-columns:minmax(300px,1fr) auto auto;gap:8px;flex:1;min-width:0}.logs-filters .el-date-editor{width:100%}
.logs-toolbar-actions{display:flex;align-items:center;gap:4px}
.logs-pagination{display:flex;justify-content:flex-end;margin-top:14px}
.logs-table :deep(.el-table__cell){padding:10px 8px}
.model-name{font-weight:600;color:var(--el-text-color-primary)}
.log-cost{font-variant-numeric:tabular-nums;color:var(--el-text-color-primary);font-weight:600}
.log-detail{display:inline-block;max-width:calc(100% - 56px);overflow:hidden;text-overflow:ellipsis;vertical-align:middle;white-space:nowrap;color:var(--el-text-color-secondary)}
.log-detail.is-error{color:var(--el-color-danger)}
.detail-button{margin-left:4px;padding:0 4px}
.detail-meta{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;font-weight:600;color:var(--el-text-color-primary)}
.log-detail-dialog pre{max-height:280px;margin:0 0 18px;padding:12px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:var(--el-fill-color-light);border:1px solid var(--el-border-color-lighter);border-radius:6px;color:var(--el-text-color-regular);font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace}
.detail-grid{display:grid;grid-template-columns:90px 1fr;gap:10px 14px;font-size:13px}.detail-grid span{color:var(--el-text-color-secondary)}.detail-grid b{font-weight:500;word-break:break-all}
@media(max-width:850px){.logs-toolbar{flex-direction:column}.logs-filters{width:100%;grid-template-columns:1fr auto auto}.logs-toolbar-actions{align-self:flex-end}}
@media(max-width:700px){.model-editor-row{grid-template-columns:1fr}.model-editor-row .el-button{width:100%}.logs-dialog{--el-dialog-width:calc(100vw - 24px)}.logs-filters{grid-template-columns:1fr}.logs-filters .el-button{width:100%}.logs-toolbar-actions{flex-direction:row;align-self:stretch;justify-content:flex-end}.logs-table{font-size:12px}.logs-table :deep(.el-table__cell){padding:8px 4px}.logs-table :deep(.el-table__header-wrapper) .el-table__cell:nth-child(4),.logs-table :deep(.el-table__body-wrapper) .el-table__cell:nth-child(4),.logs-table :deep(.el-table__header-wrapper) .el-table__cell:nth-child(5),.logs-table :deep(.el-table__body-wrapper) .el-table__cell:nth-child(5){display:none}.logs-pagination{justify-content:center;overflow:auto}}
</style>
