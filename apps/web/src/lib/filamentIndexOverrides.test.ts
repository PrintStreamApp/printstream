import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  permuteFilamentIndexOverrides,
  permutePerObjectFilamentIndexOverrides,
  remapFilamentIndexOverrides,
  remapFilamentIndexValue,
  remapPerObjectFilamentIndexOverrides
} from './filamentIndexOverrides'

test('a reference to the removed material falls back to Default', () => {
  assert.equal(remapFilamentIndexValue('2', 2), '0')
})

// The value is a POSITION in the ordered list, so deleting a material renumbers everything above
// it, without this, removing material 2 leaves "support interface" pointing at a shifted slot.
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

test('a reorder permutes filament-index references and defaults dangling ones', () => {
  // Old order [1,2,3] reversed: 1->3, 2->2, 3->1.
  const remap = new Map([[1, 3], [2, 2], [3, 1]])
  const overrides = { support_filament: '1', support_interface_filament: '3', wall_filament: '0', sparse_infill_density: '15%' }
  assert.deepEqual(permuteFilamentIndexOverrides(overrides, remap), {
    support_filament: '3',
    support_interface_filament: '1',
    wall_filament: '0',
    sparse_infill_density: '15%'
  })
  // A reference the permutation does not cover falls back to Default rather than pointing at
  // whatever material took over the number.
  assert.deepEqual(permuteFilamentIndexOverrides({ support_filament: '7' }, remap), { support_filament: '0' })
  // Identity permutation returns the SAME object so callers skip the state update.
  const identity = new Map([[1, 1], [2, 2]])
  const untouched = { support_filament: '2' }
  assert.equal(permuteFilamentIndexOverrides(untouched, identity), untouched)
})

test('per-object overrides permute and keep identity when untouched', () => {
  const remap = new Map([[1, 2], [2, 1]])
  const perObject = {
    'object-1': { support_interface_filament: '1' },
    'object-2': { sparse_infill_density: '15%' }
  }
  const next = permutePerObjectFilamentIndexOverrides(perObject, remap)
  assert.deepEqual(next['object-1'], { support_interface_filament: '2' })
  assert.equal(next['object-2'], perObject['object-2'])
})
