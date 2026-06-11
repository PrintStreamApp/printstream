import test from 'node:test'
import assert from 'node:assert/strict'
import { isInstantiableBambuStudioProfile, isInternalBambuStudioResourceName, isVisibleBambuStudioProfile } from './profile-visibility.js'

test('isVisibleBambuStudioProfile lists an instantiable preset whose type matches the collection', () => {
  assert.equal(isVisibleBambuStudioProfile('process', '0.20mm Standard @BBL H2D', {
    type: 'process',
    name: '0.20mm Standard @BBL H2D',
    instantiation: 'true'
  }), true)
})

test('isVisibleBambuStudioProfile hides @base presets that BambuStudio marks instantiation false', () => {
  assert.equal(isVisibleBambuStudioProfile('filament', 'Bambu ABS @base', {
    type: 'filament',
    name: 'Bambu ABS @base',
    instantiation: 'false'
  }), false)
})

test('isVisibleBambuStudioProfile treats a missing instantiation flag as visible', () => {
  assert.equal(isVisibleBambuStudioProfile('process', '0.20mm Standard @BBL H2D - Ryan', {
    type: 'process',
    name: '0.20mm Standard @BBL H2D - Ryan'
  }), true)
})

test('isVisibleBambuStudioProfile skips records whose type does not match the collection', () => {
  assert.equal(isVisibleBambuStudioProfile('process', 'Bambu PLA Basic @BBL H2D', {
    type: 'filament',
    name: 'Bambu PLA Basic @BBL H2D',
    instantiation: 'true'
  }), false)
})

test('isVisibleBambuStudioProfile skips internal resource records without a usable name', () => {
  assert.equal(isVisibleBambuStudioProfile('filament', 'fdm_filament_common', {
    type: 'filament',
    name: 'fdm_filament_common',
    instantiation: 'true'
  }), false)
  assert.equal(isVisibleBambuStudioProfile('filament', undefined, { type: 'filament' }), false)
})

test('isInstantiableBambuStudioProfile only excludes the explicit string "false"', () => {
  assert.equal(isInstantiableBambuStudioProfile({ instantiation: 'false' }), false)
  assert.equal(isInstantiableBambuStudioProfile({ instantiation: 'true' }), true)
  assert.equal(isInstantiableBambuStudioProfile({}), true)
})

test('isInternalBambuStudioResourceName flags BambuStudio include and parameter tables', () => {
  assert.equal(isInternalBambuStudioResourceName('fdm_process_common'), true)
  assert.equal(isInternalBambuStudioResourceName('filament_color_codes'), true)
  assert.equal(isInternalBambuStudioResourceName('support/recommended_params'), true)
  assert.equal(isInternalBambuStudioResourceName('0.20mm Standard @BBL H2D - Ryan'), false)
})
