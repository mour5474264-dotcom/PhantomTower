<script setup>
import {computed, ref} from 'vue'
import {Video, ImagePlus, Film, Download, History, RefreshCw, Play, Pause, Trash2, X, LoaderCircle, ArrowUpRight} from 'lucide-vue-next'
import {ElMessageBox} from 'element-plus'
import {VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, videoRatioOptions} from '../canvas/lib/media-size'
import {useVideoWorkbench, statusLabels} from './video/useVideoWorkbench'

const {form, models, model, modelError, loadingModels, ready, submitting, importing, records, selectedId, selected,
  previewUrl, activeIds, refreshModels, generate, addImages, pause, poll, restore, removeRecord, download} = useVideoWorkbench()
const historyOpen = ref(false)
const imageInput = ref(null)
const uploadTarget = ref('images')
const ratios = computed(() => model.value?.h3 ? ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3'] : videoRatioOptions.map(item => item.value))
const pendingCount = computed(() => records.value.filter(record => ['pending', 'submitting'].includes(record.status)).length)
const dateLabel = date => new Date(date).toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})
function chooseImages(target) {
  uploadTarget.value = target
  imageInput.value.multiple = target === 'images'
  imageInput.value.click()
}
function onFiles(event) {
  void addImages(event.target.files, uploadTarget.value)
  event.target.value = ''
}
async function deleteRecord(record) {
  try {
    await ElMessageBox.confirm('删除此条本地记录和已保存的视频？此操作不会取消服务商的生成任务。', '删除视频记录', {confirmButtonText: '删除', cancelButtonText: '保留', type: 'warning'})
    await removeRecord(record)
  } catch { /* User kept the record. */ }
}
</script>

<template>
  <section class="video-workbench" aria-label="视频生成工作台">
    <input ref="imageInput" class="video-file-input" type="file" accept="image/*" aria-label="上传参考图片" @change="onFiles" />
    <aside class="video-materials">
      <div class="video-eyebrow">VIDEO STUDIO</div>
      <div class="video-heading"><h1>视频生成</h1><Film :size="20" /></div>
      <p class="video-muted">让画面动起来，从一个想法开始。</p>
      <div class="video-modes" aria-label="生成方式">
        <button v-for="mode in [{id: 'text', label: '文生视频'}, {id: 'frames', label: '首尾帧'}, {id: 'reference', label: '参考素材'}]" :key="mode.id"
          type="button" :aria-pressed="form.mode === mode.id" :class="{active: form.mode === mode.id}" @click="form.mode = mode.id">{{ mode.label }}</button>
      </div>

      <div v-if="form.mode === 'text'" class="video-text-hint">
        <Video :size="30" :stroke-width="1.25" />
        <h2>用文字描绘镜头</h2>
        <p>描述主体、动作、场景与镜头运动。也可以切换到首尾帧或参考素材，让生成更有依据。</p>
      </div>
      <template v-else-if="form.mode === 'frames'">
        <div v-for="slot in [{key: 'firstFrame', label: '首帧', hint: '视频从这张画面开始'}, {key: 'lastFrame', label: '尾帧 · 可选', hint: '引导镜头的结束画面'}]" :key="slot.key" class="video-frame">
          <div class="video-section-title"><h2>{{ slot.label }}</h2><button v-if="form[slot.key]" class="video-icon-button" type="button" :aria-label="`移除${slot.label}`" @click="form[slot.key] = null"><X :size="15" /></button></div>
          <button type="button" class="video-upload" :disabled="importing" :aria-label="`上传${slot.label}`" @click="chooseImages(slot.key)" @dragover.prevent @drop.prevent="addImages($event.dataTransfer.files, slot.key)">
            <img v-if="form[slot.key]" :src="form[slot.key].dataUrl" :alt="form[slot.key].name" />
            <template v-else><ImagePlus :size="24" :stroke-width="1.5" /><span>点击或拖入图片</span></template>
          </button>
          <p class="video-muted">{{ slot.hint }}</p>
        </div>
        <p class="video-note">首尾帧支持情况取决于所选模型。H3 会将图片作为参考素材提交。</p>
      </template>
      <template v-else>
        <div class="video-section-title"><h2>参考图片</h2><span>{{ form.images.length }} 张</span></div>
        <button class="video-upload video-upload-compact" type="button" :disabled="importing" @click="chooseImages('images')" @dragover.prevent @drop.prevent="addImages($event.dataTransfer.files)">
          <ImagePlus :size="22" /><span>{{ importing ? '正在读取…' : '点击或拖入参考图片' }}</span>
        </button>
        <div v-if="form.images.length" class="video-reference-grid">
          <div v-for="(image, index) in form.images" :key="image.id" class="video-reference">
            <img :src="image.dataUrl" :alt="image.name" /><span>{{ index + 1 }}</span>
            <button type="button" :aria-label="`移除参考图 ${index + 1}`" @click="form.images.splice(index, 1)"><X :size="13" /></button>
          </div>
        </div>
        <label class="video-field" for="video-reference-urls">参考视频地址<textarea id="video-reference-urls" v-model="form.videoUrls" rows="2" placeholder="https://… 每行一个" /></label>
        <label class="video-field" for="audio-reference-urls">参考音频地址<textarea id="audio-reference-urls" v-model="form.audioUrls" rows="2" placeholder="https://… 每行一个" /></label>
        <p class="video-note">使用可直接访问的 HTTPS 素材链接。普通模型需允许浏览器读取素材；H3 由服务商直接读取链接。</p>
      </template>
      <div class="video-material-footer"><span class="video-dot"></span>素材与记录保存在本机浏览器</div>
    </aside>

    <div class="video-stage">
      <div class="video-stage-toolbar">
        <div><span class="video-eyebrow">PREVIEW</span><b>视频预览</b><span v-if="pendingCount" class="video-count">{{ pendingCount }} 个任务进行中</span></div>
        <button type="button" class="video-stage-button" @click="historyOpen = true"><History :size="16" />生成记录 <span>{{ records.length }}</span></button>
      </div>
      <div class="video-screen" aria-live="polite">
        <video v-if="previewUrl" :key="selectedId" :src="previewUrl" controls playsinline preload="metadata" aria-label="生成的视频" />
        <div v-else-if="selected" class="video-stage-empty">
          <LoaderCircle v-if="activeIds.has(selected.id) || selected.status === 'submitting'" class="video-spinner" :size="38" :stroke-width="1.2" />
          <Film v-else :size="38" :stroke-width="1.2" />
          <h2>{{ statusLabels[selected.status] }}</h2>
          <p>{{ selected.status === 'pending' ? (selected.error || '正在等待镜头生成，可以离开页面，返回后继续查询。') : selected.status === 'submitting' ? '正在提交生成任务，请勿重复点击。' : selected.error }}</p>
          <p v-if="selected.status === 'unknown'">请先核对服务商记录，确认是否已受理，避免重复生成。</p>
        </div>
        <div v-else class="video-stage-empty">
          <div class="video-empty-symbol"><Play :size="31" :stroke-width="1.2" /></div>
          <h2>下一段故事，从这里开始</h2>
          <p>写下镜头描述，选择模型，生成你的视频。</p>
          <span class="video-empty-caption">文字构思 / 画面参考 / 动态表达</span>
        </div>
      </div>
      <div v-if="selected" class="video-result-info">
        <div class="video-result-heading"><span class="video-status" :class="selected.status">{{ statusLabels[selected.status] }}</span><span>{{ selected.modelName }} · {{ selected.form.seconds }}s · {{ selected.form.ratio }} · {{ dateLabel(selected.createdAt) }}</span></div>
        <p class="video-result-prompt">{{ selected.form.prompt }}</p>
        <p v-if="selected.task" class="video-task-id">任务 ID：{{ selected.task.id }}</p>
        <p v-if="selected.error && previewUrl" class="video-result-error">{{ selected.error }}</p>
        <div class="video-result-actions">
          <button v-if="activeIds.has(selected.id)" type="button" class="video-stage-button" @click="pause(selected)"><Pause :size="15" />停止查询</button>
          <button v-else-if="selected.task && ['paused', 'pending'].includes(selected.status)" type="button" class="video-stage-button" @click="poll(selected)"><RefreshCw :size="15" />继续查询</button>
          <button type="button" class="video-stage-button" @click="restore(selected)"><ArrowUpRight :size="15" />复用参数</button>
          <button v-if="previewUrl" type="button" class="video-stage-button video-download" @click="download"><Download :size="15" />下载视频</button>
        </div>
      </div>
    </div>

    <form class="video-composer" @submit.prevent="generate">
      <div class="video-composer-heading"><label for="video-prompt">镜头描述</label><span>主体 · 动作 · 环境 · 运镜</span></div>
      <textarea id="video-prompt" v-model="form.prompt" class="video-prompt" rows="3" placeholder="例如：清晨的海边，一位穿白裙的女孩迎着海风缓缓回头，镜头从远景平稳推近，自然光，电影质感。" required />
      <div class="video-controls">
        <label class="video-field video-model">生成模型<select v-model="form.model" :disabled="loadingModels || !models.length" aria-label="生成模型"><option v-if="!models.length" value="">{{ loadingModels ? '正在读取模型…' : '暂无配置模型' }}</option><option v-for="item in models" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label class="video-field">时长 / 秒<input v-model.number="form.seconds" aria-label="时长 / 秒" type="number" :min="model?.h3 ? 10 : VIDEO_SECONDS_MIN" :max="model?.h3 ? 15 : VIDEO_SECONDS_MAX" step="1" required /></label>
        <label class="video-field">画面比例<select v-model="form.ratio" aria-label="画面比例"><option v-for="ratio in ratios" :key="ratio" :value="ratio">{{ ratio === 'auto' ? '自动' : ratio }}</option></select></label>
        <label v-if="!model?.h3" class="video-field">分辨率<select v-model="form.resolution" aria-label="分辨率"><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option></select></label>
        <button type="submit" class="video-generate" :disabled="!ready || submitting || importing || loadingModels || !model || !form.prompt.trim()"><LoaderCircle v-if="submitting" class="video-spinner" :size="17" /><Video v-else :size="17" />{{ submitting ? '正在提交…' : '生成视频' }}</button>
      </div>
      <div class="video-composer-footer">
        <template v-if="!model?.h3"><label><input v-model="form.audio" type="checkbox" />生成声音</label><label><input v-model="form.watermark" type="checkbox" />添加水印</label><span>参数支持情况以所选模型为准</span></template>
        <span v-else>H3：10–15 秒 · 分辨率由模型决定 · 最多 9 图 / 3 视频 / 3 音频，合计 12 个</span>
        <button type="button" class="video-refresh" :disabled="loadingModels" @click="refreshModels"><RefreshCw :size="12" />刷新模型</button>
      </div>
      <p v-if="modelError" class="video-form-error" role="alert">{{ modelError }}</p>
      <p v-else-if="!loadingModels && !models.length" class="video-form-error">请先到 <RouterLink to="/apis">API 管理</RouterLink> 配置视频模型。模型列表与无限画布共用。</p>
    </form>

    <el-dialog v-model="historyOpen" title="视频生成记录" width="780px" class="video-history-dialog">
      <div v-if="!records.length" class="video-history-empty">还没有生成记录，开始创作第一段视频吧。</div>
      <div v-else class="video-history-list">
        <article v-for="record in records" :key="record.id" class="video-history-item">
          <button type="button" class="video-history-select" @click="selectedId = record.id; historyOpen = false">
            <span class="video-history-icon"><Film :size="22" /></span>
            <span><b>{{ record.form.prompt }}</b><small>{{ record.modelName }} · {{ record.form.seconds }}s · {{ record.form.ratio }} · {{ dateLabel(record.createdAt) }}</small><em>{{ statusLabels[record.status] }}</em></span>
          </button>
          <button type="button" class="video-icon-button" :disabled="activeIds.has(record.id) || record.status === 'submitting'" aria-label="删除此条视频记录" @click="deleteRecord(record)"><Trash2 :size="17" /></button>
        </article>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.video-workbench{--video-primary:#167d70;--video-border:#cfdad5;display:grid;grid-template-columns:286px minmax(0,1fr);grid-template-rows:minmax(180px,1fr) auto;gap:8px 12px;height:100%;min-height:0;color:#263630;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.video-file-input{display:none}.video-materials{grid-row:1/3;display:flex;flex-direction:column;min-height:0;overflow:auto;padding:20px 16px;border:1px solid var(--video-border);border-radius:8px;background:#f5f8f6}.video-eyebrow{font:600 9px/1.4 Consolas,monospace;letter-spacing:1.7px;color:#268579}.video-heading,.video-section-title{display:flex;align-items:center;justify-content:space-between;gap:8px}.video-heading{margin:10px 0 4px}.video-heading h1{margin:0;font-size:21px;font-weight:650}.video-heading svg{color:var(--video-primary)}.video-muted{color:#6e7d76;font-size:11px;line-height:1.6;margin:5px 0 14px}.video-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin:8px 0 24px;padding:3px;background:#e8efeb;border-radius:6px}.video-modes button{padding:8px 2px;border:0;border-radius:4px;background:transparent;font:inherit;font-size:11px;color:#63766d;cursor:pointer}.video-modes button.active{background:#fff;color:var(--video-primary);box-shadow:0 1px 3px #183d2412;font-weight:650}.video-text-hint{padding:32px 10px;text-align:center;color:#608276;border:1px dashed #c3d4cb;border-radius:6px}.video-text-hint h2{font-size:13px;margin:16px 0 10px;color:#344d42}.video-text-hint p,.video-note{font-size:11px;line-height:1.9;color:#7a8881}.video-note{margin:12px 0}.video-section-title h2{font-size:12px;font-weight:650;margin:0}.video-section-title{margin-bottom:10px}.video-section-title>span{font-size:11px;color:#7a8881}.video-frame{margin-bottom:10px}.video-upload{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;width:100%;min-height:112px;overflow:hidden;border:1px dashed #bacfc4;border-radius:6px;background:#fff;color:#538474;font:inherit;font-size:11px;cursor:pointer}.video-upload:hover{border-color:var(--video-primary);background:#edf8f5}.video-upload img{width:100%;height:130px;object-fit:contain}.video-upload-compact{min-height:86px}.video-reference-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:12px 0}.video-reference{position:relative;aspect-ratio:1;background:#e7eeea;border-radius:5px;overflow:hidden}.video-reference img{width:100%;height:100%;object-fit:cover}.video-reference>span{position:absolute;bottom:3px;left:4px;font-size:10px;color:#fff;background:#18352d99;padding:1px 4px;border-radius:3px}.video-reference button{position:absolute;right:2px;top:2px;display:grid;place-items:center;width:21px;height:21px;background:#152d26bf;border:0;color:#fff;border-radius:4px;cursor:pointer}.video-materials>.video-field{margin-top:14px}.video-material-footer{display:flex;align-items:center;gap:7px;font-size:10px;color:#86958c;margin-top:auto;padding-top:24px}.video-dot{width:5px;height:5px;border-radius:50%;background:#6ca894}
.video-stage{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:auto;background:#111414;border:1px solid #273231;border-radius:8px;color:#dce5e0}.video-stage-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 17px;border-bottom:1px solid #26322e}.video-stage-toolbar>div{display:flex;align-items:center;gap:12px}.video-stage-toolbar b{font-size:12px;font-weight:500}.video-stage-toolbar .video-eyebrow{color:#81a797}.video-count{font-size:10px;color:#85ae9c}.video-screen{display:flex;align-items:center;justify-content:center;flex:1;min-height:180px;overflow:hidden;padding:16px}.video-screen video{display:block;width:100%;height:100%;max-height:100%;min-height:0;object-fit:contain;background:#0b0e0d;border-radius:4px}.video-stage-empty{text-align:center;padding:20px;max-width:460px;color:#6a887a}.video-stage-empty h2{margin:18px 0 10px;font-size:17px;font-weight:500;color:#d3dfd8}.video-stage-empty p{font-size:12px;line-height:1.9;color:#8a9d93;overflow-wrap:anywhere}.video-empty-symbol{display:grid;place-items:center;width:76px;height:76px;margin:auto;border:1px solid #365044;border-radius:50%;background:radial-gradient(circle,#21352a,#152019)}.video-empty-caption{display:block;margin-top:24px;font-size:10px;letter-spacing:2px;color:#577263}.video-stage-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid transparent;border-radius:5px;background:transparent;color:#baccc1;padding:6px 9px;font:inherit;font-size:11px;cursor:pointer}.video-stage-button:hover{background:#ffffff0b;color:#fff}.video-stage-button>span{font:10px Consolas;color:#80a18f}.video-result-info{padding:12px 17px;border-top:1px solid #29342f}.video-result-heading{display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:10px;color:#91a89b}.video-status{padding:3px 7px;border-radius:3px;background:#273a30;color:#acd2bd}.video-status.failed,.video-status.unknown{background:#422e25;color:#edbb9b}.video-status.paused{color:#e0cf9d;background:#383528}.video-result-prompt{font-size:12px;line-height:1.7;margin:9px 0;color:#b4c7ba;max-height:60px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.video-task-id{font:10px/1.6 Consolas,monospace;color:#829a8c;overflow-wrap:anywhere;margin:4px 0}.video-result-actions{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}.video-download{color:#9bd0b5;border-color:#34503f}.video-result-error{font-size:11px;color:#e7ba8f}
.video-composer{grid-column:2;background:#f5f8f6;border:1px solid var(--video-border);border-radius:8px;padding:14px 16px;min-width:0}.video-composer-heading{display:flex;align-items:center;justify-content:space-between;font-size:11px;margin-bottom:8px}.video-composer-heading label{font-weight:650}.video-composer-heading>span{color:#88988f;font-size:10px}.video-prompt{display:block;resize:vertical;width:100%;min-height:70px;max-height:180px;padding:10px 12px;border:1px solid #d2ddd7;border-radius:5px;background:#fff;color:#263630;font:12px/1.8 "Segoe UI","Microsoft YaHei",sans-serif;box-sizing:border-box}.video-prompt::placeholder{color:#96a39c}.video-controls{display:flex;align-items:flex-end;gap:10px;margin-top:12px}.video-field{display:flex;flex-direction:column;gap:6px;font-size:10px;color:#6d7e73;min-width:0}.video-field input,.video-field select,.video-field textarea{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #cfdad5;border-radius:5px;background:#fff;color:#304a3c;font:12px "Segoe UI","Microsoft YaHei",sans-serif;min-height:33px}.video-field textarea{resize:vertical;line-height:1.6}.video-controls>.video-field:not(.video-model){width:90px;flex-shrink:0}.video-model{flex:1;min-width:130px}.video-generate{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:8px 20px;flex-shrink:0;background:var(--video-primary);border:1px solid var(--video-primary);border-radius:5px;color:#fff;font:600 12px "Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;transition:background .16s}.video-generate:hover:not(:disabled){background:#0f6258}.video-workbench button:disabled{opacity:.5;cursor:not-allowed}.video-composer-footer{display:flex;align-items:center;gap:13px;flex-wrap:wrap;margin-top:11px;font-size:10px;color:#87988d}.video-composer-footer label{display:flex;align-items:center;gap:4px;color:#637c6b}.video-composer-footer input{accent-color:var(--video-primary)}.video-refresh{display:inline-flex;align-items:center;gap:5px;margin-left:auto;border:0;background:transparent;color:#698675;font-size:10px;cursor:pointer}.video-form-error{color:#af5343;font-size:11px;line-height:1.6;margin:8px 0 0}.video-form-error a{color:var(--video-primary)}.video-icon-button{display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:#658371;cursor:pointer}.video-icon-button:hover{background:#dceae2}.video-history-list{max-height:60vh;overflow:auto}.video-history-item{display:flex;align-items:center;border-bottom:1px solid #e1e9e3;padding:12px 0;gap:12px}.video-history-select{display:flex;gap:14px;align-items:center;flex:1;min-width:0;border:0;background:transparent;text-align:left;cursor:pointer;padding:5px;border-radius:4px}.video-history-select:hover{background:#eef5f0}.video-history-icon{display:grid;place-items:center;width:52px;height:46px;border-radius:5px;background:#e9f0eb;color:#3d7b5a;flex-shrink:0}.video-history-select>span:last-child{display:flex;flex-direction:column;gap:5px;min-width:0}.video-history-select b{font-size:12px;color:#2d4a39;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.video-history-select small{color:#8b9a90;font-size:10px}.video-history-select em{font-size:10px;font-style:normal;color:#35744f}.video-history-empty{text-align:center;padding:45px;color:#839489}.video-spinner{animation:video-spin 1.2s linear infinite}@keyframes video-spin{to{transform:rotate(360deg)}}.video-workbench :is(button,input,select,textarea):focus-visible{outline:2px solid #40a88b;outline-offset:3px}
@media(max-width:1100px){.video-workbench{grid-template-columns:240px minmax(0,1fr)}.video-controls{flex-wrap:wrap}.video-model{flex-basis:100%}.video-generate{margin-left:auto}.video-stage-toolbar .video-eyebrow{display:none}}
@media(max-width:700px){.video-workbench{height:auto;display:flex;flex-direction:column}.video-materials{max-height:none;padding:16px}.video-material-footer{padding-top:14px}.video-text-hint{padding:16px}.video-stage{min-height:330px}.video-screen{min-height:240px}.video-screen video{max-height:380px}.video-composer{padding:13px}.video-controls{gap:8px}.video-controls>.video-field:not(.video-model){width:calc(33.333% - 6px)}.video-generate{width:100%;margin-top:5px}.video-count{display:none}.video-composer-heading>span{display:none}}
@media(prefers-reduced-motion:reduce){.video-spinner{animation:none}.video-generate{transition:none}}
</style>
