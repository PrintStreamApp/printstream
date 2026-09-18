import assert from 'node:assert/strict'
import test from 'node:test'
import { materialThumbnailsChanged, type MaterialThumbnailInputs } from './materialThumbnailInvalidation'

const original: MaterialThumbnailInputs = { colors: { 1: '#FF0000', 2: '#0000FF' }, baseIds: undefined }
const replaced: MaterialThumbnailInputs = { colors: { 2: '#0000FF' }, baseIds: { 1: 2, 2: 2 } }

test('removal refreshes thumbnails even when surviving swatches did not change', () => {
  assert.equal(materialThumbnailsChanged(original, replaced), true)
  assert.equal(materialThumbnailsChanged(original, { ...replaced, baseIds: undefined }), true)
})

test('replacement mapping changes refresh untouched paint, including undo and redo', () => {
  assert.equal(materialThumbnailsChanged(original, { ...original, baseIds: replaced.baseIds }), true)
  assert.equal(materialThumbnailsChanged(replaced, original), true)
  assert.equal(materialThumbnailsChanged(original, replaced), true)
})

test('loading and identity mappings preserve lazy thumbnails while recolours invalidate them', () => {
  assert.equal(materialThumbnailsChanged(null, original), false)
  assert.equal(materialThumbnailsChanged({ colors: {}, baseIds: undefined }, original), false)
  assert.equal(materialThumbnailsChanged(original, { ...original, baseIds: { 1: 1, 2: 2 } }), false)
  assert.equal(materialThumbnailsChanged(original, { ...original, colors: { ...original.colors, 3: '#00FF00' } }), false)
  assert.equal(materialThumbnailsChanged(original, { ...original, colors: { ...original.colors, 1: '#00FF00' } }), true)
})
