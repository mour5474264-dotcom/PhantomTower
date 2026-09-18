import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'

const source = fs.readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('function syncBundledPromptTemplates('), source.indexOf('\nfunction migrateLegacyData('))

function setup(active, defaults, bundled) {
  const files = new Map()
  const user = path.resolve('test-user')
  const resources = path.resolve('test-bundle')
  const put = (dir, name, value) => files.set(path.join(dir, name), JSON.stringify(value))
  const get = name => JSON.parse(files.get(path.join(user, name)))
  const activeName = 'builtin-prompt-templates.json'
  const defaultsName = 'builtin-prompt-templates.defaults.json'
  if (active) put(user, activeName, active)
  if (defaults) put(user, defaultsName, defaults)
  put(path.join(resources, 'data'), activeName, bundled)
  put(path.join(resources, 'data'), defaultsName, bundled)
  put(user, 'prompt-templates.json', [])
  const mockFs = {
    mkdirSync() {}, existsSync: file => files.has(file),
    readFileSync: file => { if (!files.has(file)) throw Error('missing file'); return files.get(file) },
    writeFileSync: (file, value) => files.set(file, value),
    copyFileSync: (from, to) => files.set(to, files.get(from))
  }
  const sync = vm.runInNewContext(`${body}; syncBundledPromptTemplates`, {fs: mockFs, path, process: {resourcesPath: resources}})
  return {run: () => sync(user), active: () => get(activeName), defaults: () => get(defaultsName), remove: id => put(user, activeName, get(activeName).filter(item => item.id !== id))}
}

test('upgrades append arbitrary new IDs while preserving edits, custom entries and deleted old rules', () => {
  const old = {id: 'old', systemPrompt: 'original'}
  const deleted = {id: 'deleted', systemPrompt: 'deleted rule'}
  const edited = {...old, systemPrompt: 'user edit', name: 'renamed'}
  const custom = {id: 'custom', systemPrompt: 'custom rule'}
  const added = {id: 'new-function', systemPrompt: 'new rule'}
  const fixture = setup([edited, custom], [old, deleted], [{...old, systemPrompt: 'new shipped text'}, deleted, added, added])
  fixture.run()
  assert.deepEqual(fixture.active(), [edited, custom, added])
  assert.deepEqual(fixture.defaults(), [old, deleted, added])
  fixture.run()
  assert.deepEqual(fixture.active(), [edited, custom, added])
  fixture.remove(added.id)
  fixture.run()
  assert.deepEqual(fixture.active(), [edited, custom])
})

test('a pre-existing new ID retains its local content and is marked as seen', () => {
  const local = {id: 'new-function', systemPrompt: 'local edited text'}
  const fixture = setup([local], [], [{...local, systemPrompt: 'shipped text'}])
  fixture.run()
  assert.deepEqual(fixture.active(), [local])
  assert.equal(fixture.defaults()[0].id, local.id)
})

test('fresh installs receive all bundled presets', () => {
  const bundled = [{id: 'one'}, {id: 'two'}]
  const fixture = setup(null, null, bundled)
  fixture.run()
  assert.deepEqual(fixture.active(), bundled)
  assert.deepEqual(fixture.defaults(), bundled)
})
