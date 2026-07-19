import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  remapFilamentIndexOverrides,
  remapFilamentIndexValue,
  remapPerObjectFilamentIndexOverrides
} from './filamentIndexOverrides'

test('a reference to the removed material falls back to Default', () => {
  assert.equal(remapFilamentIndexValue('2', 2), '0')
})

// The value is a POSITION in the ordered list, so deleting a material renumbers everything above
// it — without this, removing material 2 leaves "support interface" pointing at a shifted slot.
test('references above the removed material shift down', () => {
  assert.equal(remapFilamentIndexValue('3', 2), '2')
  assert.equal(remapFilamentIndexValue('4', 2), '3')
})

test('references below the removed material are untouched', () => {
  assert.equal(remapFilamentIndexValue('1', 2), '1')
})

test('Default and non-numeric values pass through', () => {
  assert.equal(remapFilamentIndexValue('0', 2), '0')
  assert.equal(remapFilamentIndexValue('', 2), '')
  assert.equal(remapFilamentIndexValue('nozzle', 2), 'nozzle')
})

test('only filament-index settings are remapped', () => {
  const overrides = {
    support_interface_filament: '3',
    support_filament: '2',
    // A layer count that happens to hold the same number must not be touched.
    support_interface_top_layers: '3',
    sparse_infill_density: '15%'
  }
  assert.deepEqual(remapFilamentIndexOverrides(overrides, 2), {
    support_interface_filament: '2',
    support_filament: '0',
    support_interface_top_layers: '3',
    sparse_infill_density: '15%'
  })
})

test('an override map with no filament references is returned unchanged by identity', () => {
  const overrides = { sparse_infill_density: '15%' }
  assert.equal(remapFilamentIndexOverrides(overrides, 2), overrides)
})

test('array-valued overrides remap per entry', () => {
  const overrides = { support_filament: ['3', '1', '2'] }
  assert.deepEqual(remapFilamentIndexOverrides(overrides, 2), { support_filament: ['2', '1', '0'] })
})

test('per-object overrides remap and keep identity when untouched', () => {
  const perObject = {
    'object-1': { support_interface_filament: '3' },
    'object-2': { sparse_infill_density: '15%' }
  }
  const next = remapPerObjectFilamentIndexOverrides(perObject, 2)
  assert.deepEqual(next['object-1'], { support_interface_filament: '2' })
  assert.equal(next['object-2'], perObject['object-2'])

  const untouched = { 'object-1': { sparse_infill_density: '15%' } }
  assert.equal(remapPerObjectFilamentIndexOverrides(untouched, 2), untouched)
})
