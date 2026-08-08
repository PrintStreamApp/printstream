/**
 * Fixture values come from two real affected projects: a save made before the bake authored
 * filament physics kept the names and dropped every value (BambuStudio then showed each slot as an
 * unnamed `(<project>.3mf)` preset of bare defaults) — and a later one (CHM - H2) where the drop
 * had run at a smaller filament count, so SOME keys survived and the old all-five-absent rule read
 * the file as healthy while every slice tripped the slicer service's scaffold completion.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectProjectFilamentPhysics } from './filament-physics'

const NAMES = ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D']

/** All five sentinels, complete at plain slot width. */
const COMPLETE = {
  filament_settings_id: NAMES,
  nozzle_temperature: ['255', '255', '220'],
  nozzle_temperature_initial_layer: ['255', '255', '220'],
  filament_flow_ratio: ['0.95', '0.95', '0.98'],
  filament_density: ['1.27', '1.27', '1.26'],
  filament_diameter: ['1.75', '1.75', '1.75']
}

test('a complete project is consistent', () => {
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(COMPLETE))
  assert.equal(inspection?.inconsistent, false)
  assert.deepEqual(inspection?.missingKeys, [])
  assert.deepEqual(inspection?.staleWidthKeys, [])
})

test('a project that names presets but carries no values is flagged', () => {
  const dropped = { filament_settings_id: NAMES, filament_type: ['PETG', 'PETG', 'PLA'], filament_ids: ['GFG02', 'GFG02', 'GFA00'] }
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(dropped))
  assert.ok(inspection)
  assert.equal(inspection.inconsistent, true)
  assert.equal(inspection.slotCount, 3)
  assert.deepEqual(inspection.presentKeys, [])
  assert.equal(inspection.missingKeys.length, 5)
})

test('ANY missing sentinel flags the project, whatever else survived', () => {
  // The CHM - H2 shape: the drop ran at a smaller filament count, so `filament_density` /
  // `filament_diameter` survived while the temperatures and flow were gone — and one surviving
  // key must NOT read as "still carries its physics".
  const { nozzle_temperature: _nozzle, nozzle_temperature_initial_layer: _initial, filament_flow_ratio: _flow, ...partial } = COMPLETE
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(partial))
  assert.equal(inspection?.inconsistent, true)
  assert.deepEqual(inspection?.missingKeys, ['nozzle_temperature', 'nozzle_temperature_initial_layer', 'filament_flow_ratio'])
})

test('an empty array does not count as carrying values', () => {
  const record = { ...COMPLETE, nozzle_temperature: [] }
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, true)
})

test('a sentinel at a width matching neither slots nor slots x variants is stale', () => {
  // A 2-wide density in a 3-filament project: a leftover from a save at another filament count.
  // BambuStudio reads it positionally, so slot 3 takes whatever sits past the array's end.
  const record = { ...COMPLETE, filament_density: ['1.27', '1.26'] }
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(record))
  assert.equal(inspection?.inconsistent, true)
  assert.deepEqual(inspection?.staleWidthKeys, ['filament_density'])
})

test('legitimate BambuStudio widths are all accepted', () => {
  const record = {
    ...COMPLETE,
    // Dual-variant machine: variant-scoped keys carry slots x variants…
    filament_extruder_variant: ['Standard', 'High Flow', 'Standard', 'High Flow', 'Standard', 'High Flow'],
    nozzle_temperature: ['255', '255', '255', '255', '220', '220'],
    // …or plain slot width (a pre-variant-aware save BambuStudio still reads)…
    nozzle_temperature_initial_layer: ['255', '255', '220'],
    // …or a length-1 broadcast (measured on real printer-written files).
    filament_ramming_volumetric_speed_nc: ['nil']
  }
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(record))
  assert.equal(inspection?.inconsistent, false, JSON.stringify(inspection))
})

test('free-vector options are never width-judged', () => {
  // BambuStudio writes the AMS drying tables at option-specific column counts (4 per slot); a
  // width test there convicts every healthy file, so only the option-table keys are judged.
  const record = { ...COMPLETE, filament_dev_ams_drying_temperature: ['45', '65', '45', '60', '45', '65', '55', '55', '45', '45', '45', '45'] }
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false)
})

test('a project with no named presets has nothing to judge', () => {
  // Distinct from "inspected and consistent": a geometry-only export claims no materials at all.
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify({ filament_settings_id: [] })), null)
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify({})), null)
  assert.equal(inspectProjectFilamentPhysics(null), null)
  assert.equal(inspectProjectFilamentPhysics('not json'), null)
})
