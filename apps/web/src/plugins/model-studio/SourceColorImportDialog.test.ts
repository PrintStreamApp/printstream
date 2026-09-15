import assert from 'node:assert/strict'
import test from 'node:test'
import {
  matchSourceColorsToFilaments,
  recommendedSourceColorCount,
  sanitizeObjImportGammaPreference,
  shouldMapSourceColors,
  supportsSourceColorGamma
} from './lib/sourceColorImport'

test('source colour recommendation is bounded by four and ignores transparent corners', () => {
  assert.equal(recommendedSourceColorCount([
    1, 0, 0, 1,
    0, 1, 0, 1,
    0, 0, 1, 1,
    1, 1, 0, 1,
    0, 1, 1, 1,
    1, 1, 1, 0
  ]), 4)
})

test('source palettes match the nearest current filament colour', () => {
  assert.deepEqual(matchSourceColorsToFilaments({
    clusters: [
      { color: [0.95, 0.05, 0], count: 5 },
      { color: [0, 0.1, 0.9], count: 2 }
    ],
    labels: []
  }, [
    { id: 2, number: 1, label: 'PLA', color: '#FF0000', colorName: 'Red' },
    { id: 7, number: 2, label: 'PETG', color: '#0000FF', colorName: 'Blue' }
  ]), [2, 7])
})

test('OBJ gamma correction restores only a persisted boolean', () => {
  assert.equal(sanitizeObjImportGammaPreference(true), true)
  assert.equal(sanitizeObjImportGammaPreference(false), false)
  assert.equal(sanitizeObjImportGammaPreference('true'), false)
  assert.equal(sanitizeObjImportGammaPreference(null), false)
})

test('vertex, material, and texture source colours open the mapping flow', () => {
  assert.equal(shouldMapSourceColors('vertex'), true)
  assert.equal(shouldMapSourceColors('material'), true)
  assert.equal(shouldMapSourceColors('texture'), true)
  assert.equal(shouldMapSourceColors(undefined), false)
})

test('gamma correction is limited to non-textured OBJ source colours', () => {
  assert.equal(supportsSourceColorGamma('obj', 'vertex'), true)
  assert.equal(supportsSourceColorGamma('obj', 'material'), true)
  assert.equal(supportsSourceColorGamma('obj', 'texture'), false)
  assert.equal(supportsSourceColorGamma('fbx', 'material'), false)
  assert.equal(supportsSourceColorGamma('gltf', 'texture'), false)
})
