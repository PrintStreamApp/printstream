import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractFilamentOverriddenKeys, extractProcessOverriddenKeys, extractProjectFilamentConfig, extractProjectProcessConfig } from './three-mf-project-config.js'

test('a non-object project_settings yields null (unresolvable)', () => {
  assert.equal(extractProjectProcessConfig(null), null)
  assert.equal(extractProjectProcessConfig('nope'), null)
  assert.equal(extractProjectProcessConfig([]), null)
})

test('it keeps catalog process keys and drops unknown ones', () => {
  const result = extractProjectProcessConfig({
    wall_loops: '4',
    sparse_infill_density: '15%',
    // Not a process catalog key — must be dropped.
    some_unknown_key: 'x',
    // A filament/other key that isn't in the process catalog is also dropped.
    filament_type: ['PLA']
  })
  assert.ok(result)
  assert.equal(result!.config.wall_loops, '4')
  assert.equal(result!.config.sparse_infill_density, '15%')
  assert.equal('some_unknown_key' in result!.config, false)
})

test('it accepts both scalar and string-array values for a key', () => {
  const result = extractProjectProcessConfig({ wall_loops: '3', initial_layer_speed: ['50', '50'] })
  assert.equal(result!.config.wall_loops, '3')
  assert.deepEqual(result!.config.initial_layer_speed, ['50', '50'])
})

test('it surfaces the preset name and trims it, or null when absent/blank', () => {
  assert.equal(extractProjectProcessConfig({ print_settings_id: '  0.20mm Standard @BBL X1C  ' })!.presetName, '0.20mm Standard @BBL X1C')
  assert.equal(extractProjectProcessConfig({ print_settings_id: '   ' })!.presetName, null)
  assert.equal(extractProjectProcessConfig({})!.presetName, null)
})

test('overridden keys parse the first (process) slot and drop unknown keys', () => {
  // Bambu writes different_settings_to_system as a per-slot array; slot 0 is the process slot.
  assert.deepEqual(extractProcessOverriddenKeys(['wall_loops;sparse_infill_density;bogus_key', 'filament-slot']), ['wall_loops', 'sparse_infill_density'])
  assert.deepEqual(extractProcessOverriddenKeys('wall_loops'), ['wall_loops'])
  assert.deepEqual(extractProcessOverriddenKeys(undefined), [])
})

const FILAMENT_RECORD = {
  filament_settings_id: ['Bambu PETG Basic', 'Bambu PETG HF', 'Bambu Support For PLA/PETG'],
  nozzle_temperature: ['270', '260', '250'],
  filament_max_volumetric_speed: ['20', '35', '6'],
  // [0] = process slot, [1..n] = filament slots 1..n.
  different_settings_to_system: ['wall_loops', 'nozzle_temperature', 'nozzle_temperature;filament_max_volumetric_speed;bogus', '']
}

test('extractProjectFilamentConfig reads the given slot column, preset name, and slot overridden keys', () => {
  const slot2 = extractProjectFilamentConfig(FILAMENT_RECORD, 2)
  assert.ok(slot2)
  assert.equal(slot2!.config.nozzle_temperature, '260', 'slot 2 = 0-based index 1')
  assert.equal(slot2!.config.filament_max_volumetric_speed, '35')
  assert.equal(slot2!.presetName, 'Bambu PETG HF')
  // Slot 2's changed record sits at array index 2 (index 0 is process); unknown keys dropped.
  assert.deepEqual(slot2!.overriddenKeys, ['nozzle_temperature', 'filament_max_volumetric_speed'])
})

test('extractProjectFilamentConfig: a bare scalar applies to all slots; malformed/out-of-range yields null', () => {
  assert.equal(extractProjectFilamentConfig({ nozzle_temperature: '240' }, 3)!.config.nozzle_temperature, '240')
  assert.equal(extractProjectFilamentConfig(null, 1), null)
  assert.equal(extractProjectFilamentConfig({}, 0), null)
  assert.equal(extractProjectFilamentConfig({}, -1), null)
})

test('extractProjectFilamentConfig reads a variant-expanded slot as its V-wide block', () => {
  // BambuStudio 2.x dual-variant layout: 2 filaments x 2 extruder variants = 4 columns, slot i
  // owning the block at i*V. The block is kept as a vector, matching the shape an installed H2D
  // preset resolves to, so scalarize/shape handling downstream treats both sides alike.
  const rec = {
    filament_settings_id: ['Bambu ABS @BBL H2D', 'Bambu PETG HF @BBL H2D 0.4 nozzle'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow', 'Direct Drive Standard', 'Direct Drive High Flow'],
    nozzle_temperature: ['270', '272', '245', '247'],
    filament_type: ['ABS', 'PETG']
  }
  assert.deepEqual(extractProjectFilamentConfig(rec, 1)!.config.nozzle_temperature, ['270', '272'])
  assert.deepEqual(extractProjectFilamentConfig(rec, 2)!.config.nozzle_temperature, ['245', '247'])
  // Identity arrays stay plain per-slot reads.
  assert.equal(extractProjectFilamentConfig(rec, 2)!.presetName, 'Bambu PETG HF @BBL H2D 0.4 nozzle')
  assert.equal(extractProjectFilamentConfig(rec, 2)!.config.filament_type, 'PETG')
})

test('extractProjectFilamentConfig falls back to a plain slot read when an array matches neither width', () => {
  // A diseased file (pre-variant-aware save left 10 stale columns beside 1 filament): no mapping
  // can read it correctly, so the plain [slot-1] read stands — an honest display of what the file
  // carries — until a re-save heals the arrays.
  const rec = {
    filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle'],
    filament_extruder_variant: ['Direct Drive Standard', 'Direct Drive High Flow'],
    nozzle_temperature: ['220', '220', '245', '245', '245', '245', '245', '245', '230', '230']
  }
  assert.equal(extractProjectFilamentConfig(rec, 1)!.config.nozzle_temperature, '220')
})

test('extractFilamentOverriddenKeys reads the slot at index=projectFilamentId and drops unknown keys', () => {
  assert.deepEqual(extractFilamentOverriddenKeys(FILAMENT_RECORD.different_settings_to_system, 1), ['nozzle_temperature'])
  assert.deepEqual(extractFilamentOverriddenKeys(FILAMENT_RECORD.different_settings_to_system, 3), [])
  assert.deepEqual(extractFilamentOverriddenKeys(undefined, 1), [])
})

// Regression (2026-07-28, reported live): adding a 4th material to a 3-filament project showed 39
// changed settings. The variant-expanded branch sliced PAST the end of every array, and `[].every()`
// is true, so the out-of-range slot was written as an empty array for all 39 variant-expanded keys —
// each of which then read as "changed" against the preset. A slot the project does not have carries
// no project config at all.
test('extractProjectFilamentConfig: a slot beyond the project\'s filament count has no config', () => {
  const rec = {
    filament_settings_id: ['a', 'b', 'c'],
    filament_extruder_variant: ['0', '1', '0', '1', '0', '1'],
    nozzle_temperature: ['270', '272', '260', '262', '250', '252'],
    filament_max_volumetric_speed: ['25', '40', '25', '40', '25', '40']
  }
  // The last real slot still reads its own block...
  assert.deepEqual(extractProjectFilamentConfig(rec, 3)!.config.nozzle_temperature, ['250', '252'])
  // ...and one past it is absent, not empty.
  assert.equal(extractProjectFilamentConfig(rec, 4), null)
  assert.equal(extractProjectFilamentConfig(rec, 9), null)
})

// The distinction the whole trust inversion rests on: "declared that nothing changed" is a fact we
// can act on; "declared nothing at all" is silence from a writer that did not keep the record, and
// treating the two alike would silently discard real overrides from older files.
test('an empty changed-from-system entry is a declaration; a missing one is not', () => {
  const withRecord = {
    print_settings_id: '0.20mm Standard @BBL H2D',
    filament_settings_id: ['Bambu PLA Basic @BBL H2D', 'Bambu PETG HF @BBL H2D'],
    filament_colour: ['#408080', '#ADB1B2'],
    // Process declares two changes; slot 1 declares none; slot 2 declares one.
    different_settings_to_system: ['wall_loops;top_shell_layers', '', 'nozzle_temperature']
  }

  const process = extractProjectProcessConfig(withRecord)
  assert.equal(process?.declaresOverrides, true)
  assert.deepEqual(process?.overriddenKeys, ['wall_loops', 'top_shell_layers'])

  const slotOne = extractProjectFilamentConfig(withRecord, 1)
  assert.equal(slotOne?.declaresOverrides, true, 'an empty entry still declares')
  assert.deepEqual(slotOne?.overriddenKeys, [])

  const slotTwo = extractProjectFilamentConfig(withRecord, 2)
  assert.equal(slotTwo?.declaresOverrides, true)
  assert.deepEqual(slotTwo?.overriddenKeys, ['nozzle_temperature'])

  // Same file, record absent: silence, not a declaration of innocence.
  const { different_settings_to_system: _dropped, ...withoutRecord } = withRecord
  assert.equal(extractProjectProcessConfig(withoutRecord)?.declaresOverrides, false)
  assert.equal(extractProjectFilamentConfig(withoutRecord, 1)?.declaresOverrides, false)

  // A slot past the end of the record is undeclared too — reading past it must not read as "clean".
  assert.equal(extractProjectFilamentConfig(withRecord, 2)?.declaresOverrides, true)
  const shortRecord = { ...withRecord, different_settings_to_system: ['wall_loops'] }
  assert.equal(extractProjectFilamentConfig(shortRecord, 1)?.declaresOverrides, false)
})
