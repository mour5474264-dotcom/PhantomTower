const baseUrl = String(process.env.PHANTOM_LICENSE_API_URL || 'https://1313502904-kxzebwbdde.ap-shanghai.tencentscf.com').replace(/\/$/, '')
const adminSecret = process.env.PHANTOM_LICENSE_ADMIN_SECRET
if (!adminSecret) throw new Error('请先设置环境变量 PHANTOM_LICENSE_ADMIN_SECRET')
const command = process.argv[2]
const args = process.argv.slice(3)
const value = (flag, fallback = '') => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : fallback }
async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: {'content-type': 'application/json', 'x-admin-secret': adminSecret, ...(options.headers || {})} })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `请求失败：HTTP ${response.status}`)
  return body
}
async function issue() {
  const customerName = value('--customer'); const maxDevices = Number(value('--devices', '1')); const expiresAt = value('--expires')
  if (!customerName) throw new Error('请提供 --customer "客户名称"')
  const result = await request('/admin/licenses', {method: 'POST', body: JSON.stringify({customerName, maxDevices, expiresAt: expiresAt || null})})
  console.log(`许可证：${result.licenseKey}\n记录 ID：${result.id}`)
}
async function revoke() { const id = value('--id'); if (!id) throw new Error('请提供 --id "许可证记录 ID"'); await request(`/admin/licenses/${encodeURIComponent(id)}/revoke`, {method: 'POST'}); console.log(`已吊销许可证：${id}`) }
(command === 'issue' ? issue : command === 'revoke' ? revoke : () => { throw new Error('用法：license:issue 或 license:revoke') })().catch(error => { console.error(`\n操作失败：${error.message}`); process.exitCode = 1 })
