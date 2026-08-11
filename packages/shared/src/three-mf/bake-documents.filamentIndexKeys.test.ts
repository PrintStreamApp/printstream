import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFilamentList } from './bake-documents.js'
import type { SceneEditFilament } from '../three-mf-scene.js'

/**
 * Project-level structures whose VALUES are 1-based filament slot ids must follow a slot
 * permutation: the scalar filament-index process keys (`support_filament` and friends), the custom
 * layer print sequences, and the variant layout's `filament_self_index`. Each was previously left
 * untouched by `applyFilamentList` (they are not length-N arrays), so a reorder silently repointed
 * them at whatever material took over the old number.
 */
function project(extra: Record<string, unknown>): string {
  return JSON.stringify({
    filament_colour: ['#FF0000', '#00FF00', '#0000FF'],
    filament_type: ['PLA', 'PETG', 'ABS'],
    filament_settings_id: ['Bambu PLA Basic', 'Generic PETG', 'Generic ABS'],
    ...extra
  })
}

const slot = (type: string, settingsId: string, sourceIndex: number): SceneEditFilament =>
  ({ color: '#FFFFFF', type, settingsId, sourceIndex } as SceneEditFilament)

// Reverses the list: old slot 1 -> new 3, old 2 -> new 2, old 3 -> new 1.
const reversed = [
  slot('ABS', 'Generic ABS', 2),
  slot('PETG', 'Generic PETG', 1),
  slot('PLA', 'Bambu PLA Basic', 0)
]

test('scalar filament-index process keys follow the permutation', () => {
  const after = JSON.parse(applyFilamentList(
    project({ support_filament: '1', support_interface_filament: '3', wall_filament: '0' }),
    reversed
  )) as Record<string, unknown>
  assert.equal(after.support_filament, '3')
  assert.equal(after.support_interface_filament, '1')
  // 0 is "Default" (the object's own filament), not a slot reference.
  assert.equal(after.wall_filament, '0')
})

test('a removed slot resets its scalar references to Default by deleting the key', () => {
  const after = JSON.parse(applyFilamentList(
    project({ support_filament: '2', support_interface_filament: '1' }),
    // Slot 2 (PETG) removed.
    [slot('PLA', 'Bambu PLA Basic', 0), slot('ABS', 'Generic ABS', 2)]
  )) as Record<string, unknown>
  assert.equal('support_filament' in after, false, 'a dangling reference falls back to the default')
  assert.equal(after.support_interface_filament, '1')
})

test('first_layer_print_sequence follows the permutation and AUTO stays untouched', () => {
  const after = JSON.parse(applyFilamentList(
    project({ first_layer_print_sequence: ['2', '1', '3'] }),
    reversed
  )) as Record<string, unknown>
  assert.deepEqual(after.first_layer_print_sequence, ['2', '3', '1'])

  const auto = JSON.parse(applyFilamentList(
    project({ first_layer_print_sequence: ['0'] }),
    reversed
  )) as Record<string, unknown>
  // A leading 0 means AUTO — the entry carries no filament ids (BambuStudio's own guard).
  assert.deepEqual(auto.first_layer_print_sequence, ['0'])
})

test('other_layers_print_sequence re-keys the id tail of every chunk, not the layer ranges', () => {
  const after = JSON.parse(applyFilamentList(
    project({
      // Two chunks of [rangeStart, rangeEnd, ...filamentIds] (ParameterUtils.cpp layout).
      other_layers_print_sequence: ['2', '10', '1', '2', '3', '11', '20', '3', '2', '1'],
      other_layers_print_sequence_nums: '2'
    }),
    reversed
  )) as Record<string, unknown>
  assert.deepEqual(after.other_layers_print_sequence, ['2', '10', '3', '2', '1', '11', '20', '1', '2', '3'])
})

test('filament_self_index is rebuilt for the new slot order when TPU changes the block widths', () => {
  const after = JSON.parse(applyFilamentList(
    project({
      filament_type: ['PLA', 'TPU', 'ABS'],
      extruder_variant_list: ['Direct Drive Standard'],
      printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
      // TPU spans both printer variants where the others share the non-TPU row set — the layout
      // buildFilamentVariantRows derives. Stored index matches the CURRENT order.
      filament_extruder_variant: [
        'Direct Drive Standard', 'Direct Drive High Flow',
        'Direct Drive Standard', 'Direct Drive High Flow',
        'Direct Drive Standard', 'Direct Drive High Flow'
      ],
      filament_self_index: ['1', '1', '2', '2', '3', '3']
    }),
    // TPU moves from slot 2 to slot 1.
    [slot('TPU', 'Generic TPU', 1), slot('PLA', 'Bambu PLA Basic', 0), slot('ABS', 'Generic ABS', 2)]
  )) as Record<string, unknown>
  // Rebuilt from the REMAPPED filament_type, so row blocks follow the new order.
  assert.deepEqual(after.filament_self_index, ['1', '1', '2', '2', '3', '3'])
  assert.deepEqual(after.filament_type, ['TPU', 'PLA', 'ABS'])
})
