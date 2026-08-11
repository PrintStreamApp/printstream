import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilamentList } from './bake-documents.js'
import type { SceneEditFilament } from '../three-mf-scene.js'

/**
 * `flush_volumes_vector` is `[unload_i, load_i]` PAIRS, one per filament slot — BambuStudio seeds
 * missing flush-matrix cells from `filaments[2*i] + filaments[2*j+1]`. Its 2N length hides it from
 * `applyFilamentList`'s generic length-N remap, and BambuStudio itself only ever resizes it at the
 * tail (its own mid-list delete leaves it misaligned), so the pairs must be moved with their slots
 * explicitly or a reorder/remove leaves each material carrying another material's purge volumes.
 */
function project(vector: string[]): string {
  return JSON.stringify({
    filament_colour: ['#FF0000', '#00FF00', '#0000FF'],
    filament_type: ['PLA', 'PETG', 'ABS'],
    filament_settings_id: ['Bambu PLA Basic', 'Generic PETG', 'Generic ABS'],
    flush_volumes_vector: vector
  })
}

const slot = (type: string, settingsId: string, sourceIndex: number): SceneEditFilament =>
  ({ color: '#FFFFFF', type, settingsId, sourceIndex } as SceneEditFilament)

test('a reorder moves each slot\'s [unload, load] pair with it', () => {
  const after = JSON.parse(applyFilamentList(
    project(['101', '102', '201', '202', '301', '302']),
    // ABS first, then PLA, then PETG — a pure permutation of the same materials.
    [slot('ABS', 'Generic ABS', 2), slot('PLA', 'Bambu PLA Basic', 0), slot('PETG', 'Generic PETG', 1)]
  )) as Record<string, unknown>
  assert.deepEqual(after.flush_volumes_vector, ['301', '302', '101', '102', '201', '202'])
})

test('a removal keeps the surviving slots\' pairs, not the tail', () => {
  const after = JSON.parse(applyFilamentList(
    project(['101', '102', '201', '202', '301', '302']),
    // Slot 2 (PETG) removed: survivors are PLA and ABS.
    [slot('PLA', 'Bambu PLA Basic', 0), slot('ABS', 'Generic ABS', 2)]
  )) as Record<string, unknown>
  assert.deepEqual(after.flush_volumes_vector, ['101', '102', '301', '302'])
})

test('an added slot fills its pair with the BambuStudio default when the clone source is short', () => {
  // A stale short vector (one pair for three filaments): the missing pairs come back as 140s
  // rather than reads past the end, and the output is always exactly 2 entries per slot.
  const after = JSON.parse(applyFilamentList(
    project(['101', '102']),
    [slot('PLA', 'Bambu PLA Basic', 0), slot('PETG', 'Generic PETG', 1), slot('ABS', 'Generic ABS', 2)]
  )) as Record<string, unknown>
  assert.deepEqual(after.flush_volumes_vector, ['101', '102', '140', '140', '140', '140'])
})
