import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildBuiltinSlicingPresetId,
  buildProjectSlicingPresetId,
  isProjectSlicingPresetId,
  isSupportDisplayFilamentType,
  parseBuiltinSlicingPresetId,
  parseProjectSlicingPresetId,
  parseSlicingPresetId,
  resolveDisplayFilamentType,
  slicingPresetProvenance
} from './slicing-preset-identity.js'

// The id encodings are a persisted wire format: builtin ids travel in slice requests
// and are stored on SlicingJob rows. A round-trip test is the contract.
test('builtin preset ids round-trip, including names with separators and non-ASCII', () => {
  for (const name of [
    'Bambu PETG Basic @BBL H2D 0.4 nozzle',
    '0.20mm Standard @BBL X1C',
    'Ryan: custom; preset',
    'PLA Grün'
  ]) {
    const id = buildBuiltinSlicingPresetId('filament', name)
    assert.deepEqual(parseBuiltinSlicingPresetId(id), { kind: 'filament', name })
  }
})

// Guards the encoding against drift from the slicer's previous Buffer-based minting,
// which is what already-persisted ids were written with.
test('builtin preset id encoding matches base64url of the utf8 name', () => {
  const name = 'Bambu PLA Basic @BBL H2D'
  const expected = Buffer.from(name, 'utf8').toString('base64url')
  assert.equal(buildBuiltinSlicingPresetId('filament', name), `builtin:filament:${expected}`)
})

test('project preset ids round-trip and classify as project', () => {
  const id = buildProjectSlicingPresetId('process', '0.20mm Standard @BBL H2D - Ryan')
  assert.deepEqual(parseProjectSlicingPresetId(id), { kind: 'process', name: '0.20mm Standard @BBL H2D - Ryan' })
  assert.equal(isProjectSlicingPresetId(id), true)
  assert.equal(slicingPresetProvenance(id), 'project')
})

test('provenance classifies each id shape and refuses to guess at an unknown one', () => {
  assert.equal(slicingPresetProvenance(buildBuiltinSlicingPresetId('machine', 'Bambu Lab H2D 0.4 nozzle')), 'builtin')
  assert.equal(slicingPresetProvenance('custom:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'), 'workspace')
  assert.equal(slicingPresetProvenance('some-legacy-id'), null)
  assert.equal(slicingPresetProvenance(''), null)
  assert.equal(slicingPresetProvenance(null), null)
})

test('a custom id parses with no kind or name rather than a partial guess', () => {
  assert.deepEqual(parseSlicingPresetId('custom:abc'), { provenance: 'workspace', kind: null, name: null })
})

test('a malformed builtin id resolves to nothing instead of a half-parsed preset', () => {
  assert.equal(parseBuiltinSlicingPresetId('builtin:filament:'), null)
  assert.equal(parseBuiltinSlicingPresetId('builtin:nonsense:QUxB'), null)
  assert.equal(parseBuiltinSlicingPresetId('builtin:filament:' + buildBuiltinSlicingPresetId('filament', '   ').split(':')[2]), null)
})

// Mirrors DynamicPrintConfig::get_filament_type (BambuStudio src/libslic3r/PrintConfig.cpp).
test('display filament type derives the support spelling the AMS and 3MF both speak', () => {
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PLA', filamentIsSupport: true }), 'PLA-S')
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PA', filamentIsSupport: true }), 'PA-S')
  assert.equal(resolveDisplayFilamentType({ filamentType: 'ABS', filamentIsSupport: true }), 'ABS-S')
  // filament_id wins over the base polymer for Bambu's two first-party support filaments.
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PLA', filamentIds: ['GFS01'], filamentIsSupport: true }), 'PA-S')
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PETG', filamentIds: ['GFS00'], filamentIsSupport: true }), 'PLA-S')
})

test('display filament type leaves non-support and unsupported-polymer presets alone', () => {
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PLA' }), 'PLA')
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PLA', filamentIsSupport: false }), 'PLA')
  assert.equal(resolveDisplayFilamentType({ filamentType: 'PETG', filamentIsSupport: true }), 'PETG')
  // BambuStudio only derives ABS-S when the preset declares no filament_id.
  assert.equal(resolveDisplayFilamentType({ filamentType: 'ABS', filamentIds: ['GFB99'], filamentIsSupport: true }), 'ABS')
  assert.equal(resolveDisplayFilamentType({ filamentType: null }), undefined)
})

test('support display types are recognised from the derived spelling', () => {
  assert.equal(isSupportDisplayFilamentType('PLA-S'), true)
  assert.equal(isSupportDisplayFilamentType('pa-s'), true)
  assert.equal(isSupportDisplayFilamentType('PLA'), false)
  assert.equal(isSupportDisplayFilamentType('PLA-CF'), false)
  assert.equal(isSupportDisplayFilamentType(null), false)
})
