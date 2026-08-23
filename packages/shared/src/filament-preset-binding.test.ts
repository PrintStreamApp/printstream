/**
 * The measured failure: a repaired project whose slot values were byte-identical to a
 * BambuStudio-written file still would not bind slot 3: the one slot backed by a USER preset. The
 * two files differed in exactly one place, `inherits_group[3]`. Everything here pins that pair.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyFilamentPresetBindings, filamentPresetChangedKeys } from './filament-preset-binding.js'
import type { ProcessConfig } from './process-settings.js'

const PARENT = {
  nozzle_temperature: ['220', '220'],
  supertack_plate_temp: ['60'],
  filament_density: ['1.26']
} as unknown as ProcessConfig

test('the declared changes are the keys that actually differ from the parent', () => {
  const preset = { ...PARENT, supertack_plate_temp: ['55'] } as unknown as ProcessConfig
  assert.deepEqual(filamentPresetChangedKeys(preset, PARENT), ['supertack_plate_temp'])
})

/**
 * A preset JSON and its parent spell one value several ways, and an OVER-declared key is not
 * harmless noise: with a parent named, a declared key is exempt from BambuStudio's normalization,
 * so the file's value is kept where the parent's was wanted.
 */
test('a cosmetic spelling difference is not a change', () => {
  const preset = { ...PARENT, filament_density: ['1.260'] } as unknown as ProcessConfig
  assert.deepEqual(filamentPresetChangedKeys(preset, PARENT), [])
})

test('identity keys never reach the declared list', () => {
  const preset = { ...PARENT, filament_settings_id: ['Mine'], filament_type: ['PLA'] } as unknown as ProcessConfig
  assert.deepEqual(filamentPresetChangedKeys(preset, {} as ProcessConfig).filter((key) => key.startsWith('filament_settings')), [])
  assert.ok(!filamentPresetChangedKeys(preset, PARENT).includes('filament_type'))
})

test('a key the preset does not mention is inherited, not deleted', () => {
  assert.deepEqual(filamentPresetChangedKeys({} as ProcessConfig, PARENT), [])
})

/** Slot i sits at i+1: index 0 is the process preset and the LAST entry is the printer. */
test('bindings land at the filament offset, keeping process and printer entries', () => {
  const record: Record<string, unknown> = {
    inherits_group: ['0.20mm Standard @BBL H2D', '', '', '', 'Bambu Lab H2D 0.4 nozzle'],
    different_settings_to_system: ['wall_loops', '', '', '', '']
  }
  applyFilamentPresetBindings(record, [
    { inherits: null, changedKeys: [] },
    { inherits: null, changedKeys: [] },
    { inherits: 'Bambu PLA Basic @BBL H2D', changedKeys: ['supertack_plate_temp', 'supertack_plate_temp_initial_layer'] }
  ])

  assert.deepEqual(record.inherits_group, ['0.20mm Standard @BBL H2D', '', '', 'Bambu PLA Basic @BBL H2D', 'Bambu Lab H2D 0.4 nozzle'])
  assert.deepEqual(record.different_settings_to_system, ['wall_loops', '', '', 'supertack_plate_temp;supertack_plate_temp_initial_layer', ''])
})

/**
 * A system preset needs no parent, and saying so is a different statement from saying nothing: an
 * EMPTY entry is how BambuStudio marks one, which routes the slot to its `is_system` normalization
 * branch. It must also CLEAR a stale name left by a previous material.
 */
test('a system preset writes an empty inherits entry, clearing any stale one', () => {
  const record: Record<string, unknown> = { inherits_group: ['p', 'Old Parent', 'x'], different_settings_to_system: ['p', 'nozzle_temperature', 'x'] }
  applyFilamentPresetBindings(record, [{ inherits: null, changedKeys: [] }])
  assert.deepEqual(record.inherits_group, ['p', '', 'x'])
  assert.deepEqual(record.different_settings_to_system, ['p', '', 'x'])
})

/**
 * A caller that could not resolve a preset must not be able to blank a record it knows nothing
 * about: the project's own declared changes are the only evidence left in that case.
 */
test('a slot with no binding keeps whatever the project had', () => {
  const record: Record<string, unknown> = {
    inherits_group: ['p', 'Parent A', 'Parent B', 'printer'],
    different_settings_to_system: ['p', 'nozzle_temperature', 'filament_flow_ratio', '']
  }
  applyFilamentPresetBindings(record, [null, { inherits: 'Parent C', changedKeys: [] }])
  assert.deepEqual(record.inherits_group, ['p', 'Parent A', 'Parent C', 'printer'])
  assert.deepEqual(record.different_settings_to_system, ['p', 'nozzle_temperature', '', ''])
})

test('no bindings at all leaves the project untouched', () => {
  const record: Record<string, unknown> = { inherits_group: ['a', 'b'], different_settings_to_system: ['c', 'd'] }
  applyFilamentPresetBindings(record, [null, null])
  assert.deepEqual(record.inherits_group, ['a', 'b'])
  assert.deepEqual(record.different_settings_to_system, ['c', 'd'])
})

/** A project with no record yet still gets a well-formed pair rather than a ragged array. */
test('an absent record is created at the right width', () => {
  const record: Record<string, unknown> = {}
  applyFilamentPresetBindings(record, [{ inherits: 'P', changedKeys: ['nozzle_temperature'] }, { inherits: null, changedKeys: [] }])
  assert.deepEqual(record.inherits_group, ['', 'P', '', ''])
  assert.deepEqual(record.different_settings_to_system, ['', 'nozzle_temperature', '', ''])
})
