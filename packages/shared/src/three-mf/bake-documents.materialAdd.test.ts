/**
 * Adding or removing a material must leave a project BambuStudio can still open, and one whose new
 * material pairs actually purge.
 *
 * Both defects come from the same everyday action (the editor's "Add material"), both were silent,
 * and neither had a test. They are pinned together because they are the two halves of what an add
 * has to keep consistent: the variant layout, and the flush matrix.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentList } from './bake-documents.js'
import { inspectProjectFilamentSelfIndex } from '../filament-variant-index.js'
import type { SceneEditFilament } from '../slicing.js'

const filament = (overrides: Partial<SceneEditFilament>): SceneEditFilament =>
  ({ color: '#FFFFFF', ...overrides }) as SceneEditFilament

/** A dual-variant H2D project: 2 filaments, 4 variant rows, self index [1,1,2,2]. */
const VARIANT_PROJECT = {
  filament_colour: ['#111111', '#222222'],
  filament_type: ['PLA', 'PETG'],
  filament_ids: ['GFA00', 'GFG02'],
  filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle'],
  extruder_variant_list: ['Direct Drive Standard', 'Direct Drive High Flow'],
  printer_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
  filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
  filament_self_index: ['1', '1', '2', '2'],
  nozzle_temperature: ['220', '220', '255', '255'],
  filament_density: ['1.26', '1.27'],
  filament_diameter: ['1.75', '1.75'],
  nozzle_diameter: ['0.4', '0.4']
}

const bake = (base: Record<string, unknown>, filaments: SceneEditFilament[]): Record<string, unknown> =>
  JSON.parse(applyFilamentList(JSON.stringify(base), filaments))

/**
 * BambuStudio REFUSES TO OPEN a project whose `filament_self_index` is not exactly as long as
 * `filament_extruder_variant` (`PresetBundle.cpp` `load_config_file_config`: it throws
 * "Invalid configuration file"). The variant array grows with the filament list; the self index has
 * to grow with it, or an ordinary Add-material writes an unopenable file. The CLI rebuilds the array
 * itself, so the project still SLICES here, which is what made this invisible.
 */
test('adding a material keeps filament_self_index as long as the variant layout', () => {
  const out = bake(VARIANT_PROJECT, [
    filament({ settingsId: VARIANT_PROJECT.filament_settings_id[0], type: 'PLA', sourceIndex: 0 }),
    filament({ settingsId: VARIANT_PROJECT.filament_settings_id[1], type: 'PETG', sourceIndex: 1 }),
    filament({ settingsId: 'Bambu PLA Basic @BBL H2D', type: 'PLA', sourceIndex: 0 })
  ])
  assert.equal((out.filament_extruder_variant as string[]).length, 6)
  assert.deepEqual(out.filament_self_index, ['1', '1', '2', '2', '3', '3'])
  assert.equal(inspectProjectFilamentSelfIndex(JSON.stringify(out))?.inconsistent, false)
})

test('removing a material keeps filament_self_index as long as the variant layout', () => {
  // The TAIL remove is the one an index-shift remap calls "identity", so it took the same path.
  const out = bake(VARIANT_PROJECT, [
    filament({ settingsId: VARIANT_PROJECT.filament_settings_id[0], type: 'PLA', sourceIndex: 0 })
  ])
  assert.equal((out.filament_extruder_variant as string[]).length, 2)
  assert.deepEqual(out.filament_self_index, ['1', '1'])
  assert.equal(inspectProjectFilamentSelfIndex(JSON.stringify(out))?.inconsistent, false)
})

/**
 * A cell involving a NEW filament is seeded from `flush_volumes_vector`, exactly as BambuStudio's
 * `update_multi_material_filament_presets` does: `(i == j ? 0 : filaments[2i] + filaments[2j+1])`.
 * Cloning the source slot's row/column instead reads that slot's own DIAGONAL for the new pair,
 * which is hard zero, so the print purged nothing between two genuinely different materials and
 * nothing detected it (the guard is a length test).
 */
const FLUSH_PROJECT = {
  filament_colour: ['#111111', '#222222'],
  filament_type: ['PLA', 'PETG'],
  filament_ids: ['GFA00', 'GFG02'],
  filament_settings_id: ['Bambu PLA Basic', 'Bambu PETG HF'],
  nozzle_diameter: ['0.4'],
  flush_volumes_matrix: ['0', '280', '280', '0'],
  flush_volumes_vector: ['140', '140', '140', '140'],
  flush_multiplier: ['1']
}

test('a new material purges against the existing ones instead of getting a zero cell', () => {
  const out = bake(FLUSH_PROJECT, [
    filament({ settingsId: 'Bambu PLA Basic', type: 'PLA', sourceIndex: 0 }),
    filament({ settingsId: 'Bambu PETG HF', type: 'PETG', sourceIndex: 1 }),
    filament({ settingsId: 'Bambu ABS', type: 'ABS', sourceIndex: 0 })
  ])
  const matrix = out.flush_volumes_matrix as string[]
  assert.equal(matrix.length, 9)
  // Existing pairs keep the values the user already had.
  assert.equal(matrix[1], '280')
  assert.equal(matrix[3], '280')
  // Every pair involving the new slot purges; only the diagonal is zero.
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cell = matrix[row * 3 + col]
      if (row === col) assert.equal(cell, '0', `diagonal (${row},${col}) must be 0`)
      else assert.notEqual(cell, '0', `(${row},${col}) is a swap between different materials and must purge`)
    }
  }
})

test('a single-filament project growing to two does not end up all zero', () => {
  // The worst shape: a stored matrix of just ["0"], whose every cloned cell is that one zero.
  const out = bake({ ...FLUSH_PROJECT, filament_colour: ['#111111'], filament_type: ['PLA'],
    filament_ids: ['GFA00'], filament_settings_id: ['Bambu PLA Basic'],
    flush_volumes_matrix: ['0'], flush_volumes_vector: ['140', '140'] }, [
    filament({ settingsId: 'Bambu PLA Basic', type: 'PLA', sourceIndex: 0 }),
    filament({ settingsId: 'Bambu PETG HF', type: 'PETG', sourceIndex: 0 })
  ])
  assert.deepEqual(out.flush_volumes_matrix, ['0', '280', '280', '0'])
})
