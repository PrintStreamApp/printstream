import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APPEND_SOURCE_COLOR,
  matchSourceColorsToFilaments,
  planSourceColorImport,
  recommendedSourceColorCount,
  sanitizeObjImportGammaPreference,
  shouldMapSourceColors,
  supportsSourceColorGamma,
  type SourceColorImportChoice
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

test('source-colour commit plans appended slots in the controller allocation order', () => {
  const plan = planSourceColorImport({
    quantized: {
      clusters: [
        { color: [1, 0, 0], count: 5 },
        { color: [0, 0, 1], count: 3 },
        { color: [1, 0, 0], count: 1 }
      ],
      labels: []
    },
    mappings: [APPEND_SOURCE_COLOR, APPEND_SOURCE_COLOR, 2]
  }, [
    { id: 2, number: 1, label: 'PLA', color: '#FF0000', colorName: 'Red' },
    { id: 7, number: 2, label: 'PETG', color: '#0000FF', colorName: 'Blue' }
  ], { 2: 'pla-preset', 7: 'petg-preset' })

  assert.deepEqual(plan, {
    ok: true,
    filamentIds: [8, 9, 2],
    baseFilamentId: 8,
    appended: [
      { optionId: 'pla-preset', color: '#ff0000', label: 'PLA' },
      { optionId: 'petg-preset', color: '#0000ff', label: 'PETG' }
    ]
  })
})

test('source-colour commit refuses append without a preset or beyond 255 slots', () => {
  const choice: SourceColorImportChoice = {
    quantized: { clusters: [{ color: [1, 0, 0], count: 1 }], labels: [] },
    mappings: [APPEND_SOURCE_COLOR]
  }
  const filament = { id: 255, number: 1, label: 'PLA', color: '#FF0000', colorName: 'Red' }
  assert.deepEqual(planSourceColorImport(choice, [filament], null), {
    ok: false,
    error: 'A matching material preset is needed before a new filament can be appended.'
  })
  assert.deepEqual(planSourceColorImport(choice, [filament], { 255: 'pla-preset' }), {
    ok: false,
    error: 'This colour mapping would exceed the project limit of 255 filaments.'
  })
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
