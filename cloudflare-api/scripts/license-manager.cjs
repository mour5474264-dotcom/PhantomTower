const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const path = require('node:path')

const apiDirectory = path.resolve(__dirname, '..')
const projectDirectory = path.resolve(apiDirectory, '..')
const wranglerEntry = path.join(projectDirectory, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const command = process.argv[2]
const args = process.argv.slice(3)

function valueFor(flag, fallback = '') {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}

function runWrangler(wranglerArgs) {
  execFileSync(process.execPath, [wranglerEntry, ...wranglerArgs], {
    cwd: apiDirectory,
    stdio: 'inherit'
  })
}

function sqlValue(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function issue() {
  const customer = valueFor('--customer')
  const devices = Number(valueFor('--devices', '1'))
  const expires = valueFor('--expires')
  const database = valueFor('--database', 'phantom-tower')
  if (!customer) throw new Error('请提供客户名称，例如：--customer "张三"')
  if (!Number.isInteger(devices) || devices < 1 || devices > 100) throw new Error('--devices 必须是 1 到 100 的整数')
  if (expires && Number.isNaN(Date.parse(expires))) throw new Error('--expires 必须是有效日期，例如 2027-08-15')

  const licenseKey = `PT-${crypto.randomBytes(20).toString('hex').toUpperCase()}`
  const licenseHash = crypto.createHash('sha256').update(licenseKey, 'utf8').digest('hex')
  const id = crypto.randomUUID()
  const expiresSql = expires ? sqlValue(new Date(expires).toISOString()) : 'NULL'
  const sql = `INSERT INTO licenses (id, license_key_hash, customer_name, status, max_devices, expires_at) VALUES (${sqlValue(id)}, ${sqlValue(licenseHash)}, ${sqlValue(customer)}, 'active', ${devices}, ${expiresSql});`

  runWrangler(['d1', 'execute', database, '--remote', '--command', sql])
  console.log('\n许可证已创建。请立即保存下面完整许可证，数据库无法恢复原文：')
  console.log(`客户：${customer}`)
  console.log(`设备数：${devices}`)
  console.log(`许可证：${licenseKey}`)
  console.log(`记录 ID：${id}`)
}

function list() {
  const database = valueFor('--database', 'phantom-tower')
  runWrangler(['d1', 'execute', database, '--remote', '--command', 'SELECT l.id, l.customer_name, l.status, l.max_devices, COUNT(d.id) AS used_devices, MAX(d.last_seen_at) AS last_seen_at, l.expires_at, l.created_at FROM licenses l LEFT JOIN devices d ON d.license_id = l.id GROUP BY l.id ORDER BY l.created_at DESC;'])
}

function revoke() {
  const database = valueFor('--database', 'phantom-tower')
  const id = valueFor('--id')
  if (!id) throw new Error('请提供许可证记录 ID，例如：--id license-uuid')
  runWrangler(['d1', 'execute', database, '--remote', '--command', `UPDATE licenses SET status = 'revoked' WHERE id = ${sqlValue(id)};`])
  console.log(`已吊销许可证：${id}`)
}

try {
  if (command === 'issue') issue()
  else if (command === 'list') list()
  else if (command === 'revoke') revoke()
  else throw new Error('用法：license:issue、license:list 或 license:revoke')
} catch (error) {
  console.error(`\n发卡失败：${error.message}`)
  process.exitCode = 1
}
