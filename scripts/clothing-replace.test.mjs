import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('../src/views/Workspace.vue', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
function extract(name, next, context) {
  const start = source.indexOf(`function ${name}(`)
  const end = source.indexOf(`\nfunction ${next}(`, start)
  assert(start >= 0 && end > start)
  return vm.runInNewContext(`${source.slice(start, end)}; ${name}`, context)
}

test('clothing tasks require both inputs and isolate unrelated materials', () => {
  const person = {name: 'target.png'}
  const materials = {value: {clothingPerson: [person], clothing: [], reference: [{name: 'unrelated.png'}]}}
  const context = {materials, imageOperation: {value: 'clothing-replace'}, clothingScope: {value: 'top'}, clothingScopes: {top: 'Top'}}
  const tasks = extract('buildImageTasks', 'imageValidationError', context)
  const validate = extract('imageValidationError', 'buildMaterialPrompt', context)
  assert.equal(tasks().length, 0)
  assert.notEqual(validate(), '')
  materials.value.clothing = [{name: 'garment.png'}]
  assert.equal(validate(), '')
  const [task] = tasks()
  assert.equal(task.item, person)
  assert.deepEqual(Array.from(task.materialKeys), ['clothingPerson', 'clothing'])
  assert.equal(task.type, 'clothing-replace')
  context.clothingScope.value = 'bottom'
  assert.equal(task.clothingScope, 'top', 'queued task retains its original scope')
  materials.value.clothingPerson = []
  assert.notEqual(validate(), '')
})

test('clothing prompt uses the captured scope and excludes unrelated preset rules', () => {
  const prompt = extract('buildMaterialPrompt', 'buildTasks', {})
  const make = scope => prompt([{}, {}], 'clothing-replace', '', '', 'UNRELATED_PRESET', scope)
  assert.match(make('top'), /只替换上衣，保留原图下装/)
  assert.match(make('bottom'), /只替换下装，保留原图上衣/)
  assert.match(make('outfit'), /参考图未提供的服装部分保持原样/)
  assert.doesNotMatch(make('outfit'), /UNRELATED_PRESET/)
  assert.doesNotMatch(make('outfit'), /绝不带入其中的人脸/, 'editable rules must not be duplicated in the frontend')
})

test('saved clothing rules retain their operation and supply the generation prompt', () => {
  const functions = server.slice(server.indexOf('function normalizePromptTemplate('), server.indexOf('async function savePromptTemplates('))
  const {normalizePromptTemplate, promptTemplateMatches} = vm.runInNewContext(`${functions}; ({normalizePromptTemplate, promptTemplateMatches})`)
  const defaults = JSON.parse(readFileSync(new URL('../data/builtin-prompt-templates.defaults.json', import.meta.url), 'utf8'))
  const original = defaults.find(item => item.operation === 'clothing-replace')
  assert(original)
  const edited = normalizePromptTemplate({...original, systemPrompt: 'USER_EDITED_CLOTHING_RULE', defaultNegativePrompt: 'USER_NEGATIVE'}, original)
  assert.equal(edited.operation, 'clothing-replace')
  assert.equal(edited.version, original.version + 1)
  assert(promptTemplateMatches(edited, 'image', 'clothing-replace'))
  assert(!promptTemplateMatches(edited, 'image', 'batch'))
  const start = server.indexOf('const finalPrompt = [builtIn?.systemPrompt')
  const end = server.indexOf('\n            if (!api)', start)
  const finalPrompt = vm.runInNewContext(`${server.slice(start, end)}; finalPrompt`, {
    builtIn: edited, userTemplate: null, input: {prompt: '【本次替换范围】只替换上衣', extraPrompt: ''}
  })
  assert.match(finalPrompt, /USER_EDITED_CLOTHING_RULE/)
  assert.match(finalPrompt, /USER_NEGATIVE/)
  assert.match(finalPrompt, /只替换上衣/)
  assert.doesNotMatch(finalPrompt, /绝不带入其中的人脸/)
})
