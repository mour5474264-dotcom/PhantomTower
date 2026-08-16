const http = require('node:http')
const { execFileSync, spawn } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')

const apiDirectory = path.resolve(__dirname, '..')
const projectDirectory = path.resolve(apiDirectory, '..')
const wranglerEntry = path.join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const database = 'phantom-tower'
const port = 9374

function sqlValue(value) { return `'${String(value).replaceAll("'", "''")}'` }
function runWrangler(args) {
  try {
    return execFileSync(process.execPath, [wranglerEntry, 'd1', 'execute', database, '--remote', '--json', ...args], {
      cwd: apiDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim()
    throw new Error(detail || 'Wrangler 执行失败，请重启管理台后重试')
  }
}
function query(sql) {
  const output = runWrangler(['--command', sql])
  const match = output.match(/\[\s*\{\s*"results"[\s\S]*\}\s*\]\s*$/)
  if (!match) throw new Error('无法读取 D1 查询结果')
  return JSON.parse(match[0])[0].results || []
}
function execute(sql) { runWrangler(['--command', sql]) }
function listLicenses() {
  return query('SELECT l.id, l.customer_name, l.status, l.max_devices, COUNT(d.id) AS used_devices, MAX(d.last_seen_at) AS last_seen_at, l.expires_at, l.created_at FROM licenses l LEFT JOIN devices d ON d.license_id = l.id GROUP BY l.id ORDER BY l.created_at DESC;')
}
function issueLicense(input) {
  const customer = String(input.customer || '').trim()
  const devices = Number(input.devices || 1)
  const expires = String(input.expires || '').trim()
  if (!customer) throw new Error('请填写客户名称')
  if (!Number.isInteger(devices) || devices < 1 || devices > 100) throw new Error('设备数必须是 1 到 100 的整数')
  if (expires && Number.isNaN(Date.parse(expires))) throw new Error('到期日格式不正确')
  const licenseKey = `PT-${crypto.randomBytes(20).toString('hex').toUpperCase()}`
  const hash = crypto.createHash('sha256').update(licenseKey, 'utf8').digest('hex')
  const id = crypto.randomUUID()
  const expiresSql = expires ? sqlValue(new Date(expires).toISOString()) : 'NULL'
  execute(`INSERT INTO licenses (id, license_key_hash, customer_name, status, max_devices, expires_at) VALUES (${sqlValue(id)}, ${sqlValue(hash)}, ${sqlValue(customer)}, 'active', ${devices}, ${expiresSql});`)
  return { id, customer, devices, licenseKey, expiresAt: expires || null }
}
function revokeLicense(id) {
  execute(`UPDATE licenses SET status = 'revoked' WHERE id = ${sqlValue(id)};`)
}
function deleteLicense(id) {
  const rows = query(`SELECT status FROM licenses WHERE id = ${sqlValue(id)} LIMIT 1;`)
  if (!rows.length) throw new Error('许可证不存在')
  if (rows[0].status !== 'revoked') throw new Error('只能删除已吊销的许可证')
  // D1 remote execution is more reliable when each statement is sent separately.
  execute(`DELETE FROM devices WHERE license_id = ${sqlValue(id)};`)
  execute(`DELETE FROM licenses WHERE id = ${sqlValue(id)};`)
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk; if (body.length > 100000) request.destroy() })
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new Error('请求格式错误')) } })
    request.on('error', reject)
  })
}

const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>样片工厂 · 许可证管理</title><style>
:root{--ink:#29261f;--muted:#70695d;--line:#d8d0c2;--paper:#fffdf8;--ground:#eee9df;--accent:#245b4d;--danger:#ad372e}*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.45 "Microsoft YaHei",system-ui,sans-serif}.shell{max-width:1180px;margin:0 auto;padding:44px 28px 72px}.top{display:flex;justify-content:space-between;align-items:end;border-bottom:2px solid var(--ink);padding-bottom:20px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:1.6px;color:var(--accent)}h1{margin:4px 0 0;font:700 30px/1.1 Georgia,"Microsoft YaHei",serif;letter-spacing:0}.top small{color:var(--muted)}.issue{display:grid;grid-template-columns:1.4fr .6fr .9fr auto;gap:12px;align-items:end;padding:24px 0 30px;border-bottom:1px solid var(--line)}label{display:grid;gap:6px;font-size:12px;font-weight:700;color:var(--muted)}input{width:100%;height:40px;border:1px solid #bdb3a3;border-radius:2px;background:var(--paper);padding:0 10px;font:inherit;color:var(--ink)}input:focus{outline:2px solid #87a89f;outline-offset:1px}button{height:40px;border:0;border-radius:2px;padding:0 16px;background:var(--ink);color:white;font:700 13px inherit;cursor:pointer}button:hover{background:#4a463b}button:disabled{opacity:.55;cursor:wait}.toolbar{display:flex;justify-content:space-between;align-items:center;padding:24px 0 12px}.toolbar h2{margin:0;font-size:16px}.count{color:var(--muted)}.table-wrap{overflow:auto;border:1px solid var(--line);background:var(--paper)}table{width:100%;border-collapse:collapse;min-width:830px}th,td{padding:13px 15px;text-align:left;border-bottom:1px solid #e6dfd4}th{background:#f4f0e8;color:var(--muted);font-size:11px;letter-spacing:.7px;text-transform:uppercase}tr:last-child td{border-bottom:0}.status{display:inline-block;padding:3px 8px;border-radius:99px;font-size:12px;font-weight:700}.status.active{background:#dcebe6;color:#1e5a4b}.status.revoked{background:#f4dedd;color:#943329}.revoke{height:30px;padding:0 10px;background:transparent;color:var(--danger);border:1px solid #d8a39c}.revoke:hover{background:#f8e6e3}.empty,.error{padding:36px;color:var(--muted);text-align:center}.error{color:var(--danger)}.notice{position:fixed;right:24px;bottom:24px;max-width:min(420px,calc(100vw - 48px));padding:16px 18px;background:#1f2e2a;color:#fff;box-shadow:0 12px 30px #0003}.notice b{display:block;margin-bottom:6px}.notice code{display:block;overflow-wrap:anywhere;padding:8px;background:#13201d;color:#d9eee7}.notice button{margin-top:10px;background:#fff;color:#202720}@media(max-width:760px){.shell{padding:26px 16px}.top{align-items:start;gap:14px;flex-direction:column}.issue{grid-template-columns:1fr}.issue button{width:100%}}
</style><body><div class="shell"><header class="top"><div><div class="eyebrow">LOCAL LICENSE CONSOLE</div><h1>许可证管理</h1></div><small>仅本机访问 · Cloudflare D1</small></header><form class="issue" id="issue-form"><label>客户名称<input name="customer" required placeholder="例如：张三 / 公司名称"></label><label>设备数<input name="devices" type="number" min="1" max="100" value="1" required></label><label>到期日（可选）<input name="expires" type="date"></label><button>创建许可证</button></form><section><div class="toolbar"><h2>客户授权</h2><span class="count" id="count">读取中...</span></div><div class="table-wrap"><table><thead><tr><th>客户</th><th>状态</th><th>已用 / 限额</th><th>最近验证</th><th>到期日</th><th>创建时间</th><th></th></tr></thead><tbody id="rows"></tbody></table></div></section></div><div class="notice" id="notice" hidden></div><script>
const rows=document.querySelector('#rows'),count=document.querySelector('#count'),notice=document.querySelector('#notice');const time=v=>v?new Date(v.replace(' ','T')+'Z').toLocaleString('zh-CN'):'-';const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showNotice(html){notice.innerHTML=html;notice.hidden=false}function closeNotice(){notice.hidden=true}
async function load(){rows.innerHTML='<tr><td class="empty" colspan="7">正在读取...</td></tr>';try{const r=await fetch('/api/licenses'),data=await r.json();if(!r.ok)throw Error(data.error);count.textContent=data.length+' 位客户';rows.innerHTML=data.length?data.map(x=>'<tr><td><b>'+esc(x.customer_name||'未命名旧许可证')+'</b><br><small>'+esc(x.id)+'</small></td><td><span class="status '+esc(x.status)+'">'+esc(x.status==='active'?'有效':'已吊销')+'</span></td><td>'+x.used_devices+' / '+x.max_devices+'</td><td>'+time(x.last_seen_at)+'</td><td>'+time(x.expires_at)+'</td><td>'+time(x.created_at)+'</td><td>'+ (x.status==='active'?'<button class="revoke" data-action="revoke" data-id="'+esc(x.id)+'">吊销</button>':'<button class="revoke" data-action="delete" data-id="'+esc(x.id)+'">删除</button>')+'</td></tr>').join(''):'<tr><td class="empty" colspan="7">还没有客户许可证</td></tr>'}catch(e){rows.innerHTML='<tr><td class="error" colspan="7">读取失败：'+esc(e.message)+'</td></tr>';count.textContent='读取失败'}}
document.querySelector('#issue-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;const button=form.querySelector('button'),data=Object.fromEntries(new FormData(form));button.disabled=true;try{const r=await fetch('/api/licenses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}),x=await r.json();if(!r.ok)throw Error(x.error);form.reset();form.elements.devices.value=1;showNotice('<b>许可证创建成功</b><span>请立即复制保存，刷新后不能再显示原文。</span><code>'+esc(x.licenseKey)+'</code><button onclick="navigator.clipboard.writeText('+JSON.stringify(x.licenseKey)+')">复制许可证</button> <button onclick="closeNotice()">关闭</button>');load()}catch(err){showNotice('<b>创建失败</b><span>'+esc(err.message)+'</span><button onclick="closeNotice()">关闭</button>')}finally{button.disabled=false}});
rows.addEventListener('click',async e=>{const target=e.target,id=target.dataset.id,action=target.dataset.action;if(!id||!action)return;const isDelete=action==='delete';if(!confirm(isDelete?'确定永久删除该已吊销许可证？此操作不可恢复。':'确定吊销该许可证？客户下次联网验证将无法使用。'))return;const endpoint=isDelete?'/api/licenses/'+encodeURIComponent(id):'/api/licenses/'+encodeURIComponent(id)+'/revoke';try{const r=await fetch(endpoint,{method:isDelete?'DELETE':'POST'}),x=await r.json();if(!r.ok)throw Error(x.error||'操作失败');load()}catch(error){showNotice('<b>操作失败</b><span>'+esc(error.message||'无法连接管理台，请重试')+'</span><button onclick="closeNotice()">关闭</button>')}});load();
</script></body></html>`

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`)
    if (request.method === 'GET' && url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(page); return }
    if (request.method === 'GET' && url.pathname === '/api/licenses') return sendJson(response, 200, listLicenses())
    if (request.method === 'POST' && url.pathname === '/api/licenses') return sendJson(response, 201, issueLicense(await readBody(request)))
    const revokeMatch = url.pathname.match(/^\/api\/licenses\/([^/]+)\/revoke$/)
    if (request.method === 'POST' && revokeMatch) { revokeLicense(decodeURIComponent(revokeMatch[1])); return sendJson(response, 200, { ok: true }) }
    const deleteMatch = url.pathname.match(/^\/api\/licenses\/([^/]+)$/)
    if (request.method === 'DELETE' && deleteMatch) { deleteLicense(decodeURIComponent(deleteMatch[1])); return sendJson(response, 200, { ok: true }) }
    sendJson(response, 404, { error: 'not_found' })
  } catch (error) { sendJson(response, 400, { error: error.message || '操作失败' }) }
})

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`
  console.log(`许可证管理台已启动：${url}`)
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
})
