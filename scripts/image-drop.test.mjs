import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GENERATED_IMAGE_DRAG_TYPE,
  normalizeImageFile,
  droppedFiles,
  droppedGeneratedImageUrl,
  setGeneratedImageDrag
} from '../src/utils/image-drop.mjs'

test('native drops with missing MIME retain bytes and gain an image type', async () => {
  for (const type of ['', 'application/octet-stream']) {
    const source = new File(['image bytes'], '人物.JPG', {type, lastModified: 123})
    const file = normalizeImageFile(source)
    assert.equal(file.type, 'image/jpeg')
    assert.equal(file.name, source.name)
    assert.equal(file.lastModified, 123)
    assert.equal(await file.text(), 'image bytes')
  }
})

test('normal picker images are preserved and unsupported inputs are rejected', () => {
  const file = new File(['png'], 'image.png', {type: 'image/png'})
  assert.equal(normalizeImageFile(file), file)
  assert.equal(normalizeImageFile(new File(['text'], 'notes.txt')), null)
  assert.equal(normalizeImageFile(new File(['text'], 'fake.jpg', {type: 'text/plain'})), null)
  assert.equal(normalizeImageFile({name: 'folder.png', isDirectory: true}), null)
})

test('drop reads file lists once without duplicating items and falls back to file items', () => {
  const file = new File(['png'], 'image.png')
  const item = {kind: 'file', getAsFile: () => file}
  assert.deepEqual(droppedFiles({files: [file], items: [item]}), [file])
  assert.deepEqual(droppedFiles({files: [], items: [item, {kind: 'string'}, {kind: 'file', getAsFile: () => null}]}), [file])
  assert.deepEqual(droppedFiles(null), [])
})

test('generated image drag preserves a Safari-compatible namespaced fallback', () => {
  const data = new Map()
  const transfer = {
    setData: (type, value) => data.set(type, value),
    getData: (type) => data.get(type) || ''
  }
  setGeneratedImageDrag(transfer, 'http://127.0.0.1:4317/api/generated/sample.png')
  assert.equal(transfer.effectAllowed, 'copy')
  assert.equal(data.get(GENERATED_IMAGE_DRAG_TYPE), 'http://127.0.0.1:4317/api/generated/sample.png')
  assert.equal(droppedGeneratedImageUrl(transfer), 'http://127.0.0.1:4317/api/generated/sample.png')
  assert.equal(droppedGeneratedImageUrl({getData: (type) => type === 'text/plain' ? 'phantom-tower-generated-image:data:image/png;base64,abc' : ''}), 'data:image/png;base64,abc')
  assert.equal(droppedGeneratedImageUrl({getData: (type) => type === 'text/plain' ? 'https://untrusted.example/image.png' : ''}), '')
})
