/**
 * Fixture values come from a real affected project: a save made before the bake authored filament
 * physics kept the names and dropped every value, and BambuStudio then showed each slot as an unnamed
 * `(<project>.3mf)` preset of bare defaults.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectProjectFilamentPhysics } from './filament-physics'

const NAMES = ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PLA Basic @BBL H2D']

test('a project that names presets but carries no values is flagged', () => {
  const dropped = { filament_settings_id: NAMES, filament_type: ['PETG', 'PETG', 'PLA'], filament_ids: ['GFG02', 'GFG02', 'GFA00'] }
  const inspection = inspectProjectFilamentPhysics(JSON.stringify(dropped))
  assert.ok(inspection)
  assert.equal(inspection.inconsistent, true)
  assert.equal(inspection.slotCount, 3)
  assert.deepEqual(inspection.presentKeys, [])
})

test('any sentinel present means the physics is intact', () => {
  // The drop was all-or-nothing, so one unconditional key is enough to tell the two apart — which is
  // what lets this stay a pure function of the file instead of needing the resolved presets.
  for (const key of ['nozzle_temperature', 'filament_flow_ratio', 'filament_density', 'filament_diameter']) {
    const record = { filament_settings_id: NAMES, [key]: ['1', '1', '1'] }
    assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, false, `${key} should count as intact`)
  }
})

test('an empty array does not count as carrying values', () => {
  const record = { filament_settings_id: NAMES, nozzle_temperature: [] }
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify(record))?.inconsistent, true)
})

test('a project with no named presets has nothing to judge', () => {
  // Distinct from "inspected and consistent": a geometry-only export claims no materials at all.
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify({ filament_settings_id: [] })), null)
  assert.equal(inspectProjectFilamentPhysics(JSON.stringify({})), null)
  assert.equal(inspectProjectFilamentPhysics(null), null)
  assert.equal(inspectProjectFilamentPhysics('not json'), null)
})
