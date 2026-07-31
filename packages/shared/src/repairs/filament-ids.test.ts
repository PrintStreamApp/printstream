/**
 * Fixtures are Ryan's real project, an ABS build switched to PETG: the BROKEN save carried
 * `["GFB00","GFB00","GFS06"]` (Bambu ABS, ABS, Support for ABS) beside PETG HF / PLA Basic names,
 * and BambuStudio's own save of the same project carried `["GFG02","GFG02","GFA00"]`. The repair's
 * job is to turn the first into the second.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inspectProjectFilamentIds, repairFilamentIds, filamentIdForPresetName } from './filament-ids'
import { collectSettingsRepairReasons } from './index'

const BROKEN = {
  // A physics sentinel keeps this a project whose ONLY defect is the ids (see filament-physics.ts).
  nozzle_temperature: ['245', '245', '220'],
  filament_settings_id: [
    'Bambu PETG HF @BBL H2D 0.4 nozzle',
    'Bambu PETG HF @BBL H2D 0.4 nozzle',
    'Bambu PLA Basic @BBL H2D - 55 degree plate'
  ],
  filament_ids: ['GFB00', 'GFB00', 'GFS06'],
  filament_type: ['PETG', 'PETG', 'PLA']
}

test('the machine suffix is not part of the material name', () => {
  // Truncating at the first `@` is what reproduces the id BambuStudio itself writes — everything
  // after it qualifies the MACHINE (plate type, nozzle size), not the filament.
  assert.equal(filamentIdForPresetName('Bambu PETG HF @BBL H2D 0.4 nozzle'), 'GFG02')
  assert.equal(filamentIdForPresetName('Bambu PLA Basic @BBL H2D - 55 degree plate'), 'GFA00')
  assert.equal(filamentIdForPresetName('Bambu PLA Basic'), 'GFA00')
})

test('detects the id/name contradiction and names the wrong material', () => {
  const inspection = inspectProjectFilamentIds(JSON.stringify(BROKEN))
  assert.ok(inspection)
  assert.equal(inspection.inconsistent, true)
  assert.equal(inspection.repairable.length, 3)
  assert.deepEqual(
    inspection.repairable.map((slot) => [slot.index, slot.currentMaterial, slot.expectedId]),
    [[0, 'Bambu ABS', 'GFG02'], [1, 'Bambu ABS', 'GFG02'], [2, 'Bambu Support for ABS', 'GFA00']]
  )
  assert.equal(inspection.unresolved.length, 0)
})

test('repairing reproduces what BambuStudio writes for the same project', () => {
  const record: Record<string, unknown> = JSON.parse(JSON.stringify(BROKEN))
  const corrected = repairFilamentIds(record)
  assert.equal(corrected.length, 3)
  assert.deepEqual(record.filament_ids, ['GFG02', 'GFG02', 'GFA00'])
  // Names and types are the slot's own data and must not be touched by an id repair.
  assert.deepEqual(record.filament_settings_id, BROKEN.filament_settings_id)
  assert.deepEqual(record.filament_type, BROKEN.filament_type)
})

test('an unmatched preset is left alone and reported, never guessed', () => {
  const record: Record<string, unknown> = {
    filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle', 'Bambu PETG HF - Custom', 'Totally Third Party PLA'],
    filament_ids: ['GFB00', 'GFB00', 'GFS06']
  }
  const inspection = inspectProjectFilamentIds(JSON.stringify(record))
  assert.ok(inspection)
  assert.deepEqual(inspection.repairable.map((slot) => slot.index), [0])
  assert.deepEqual(inspection.unresolved.map((slot) => slot.presetName), ['Bambu PETG HF - Custom', 'Totally Third Party PLA'])

  repairFilamentIds(record)
  // Only the confidently-resolvable slot changed; the other two keep exactly what they had.
  assert.deepEqual(record.filament_ids, ['GFG02', 'GFB00', 'GFS06'])
})

test('a consistent project is not flagged, and an empty id is not a contradiction', () => {
  const consistent = { nozzle_temperature: ['245', '245', '220'], filament_settings_id: BROKEN.filament_settings_id, filament_ids: ['GFG02', 'GFG02', 'GFA00'] }
  assert.equal(inspectProjectFilamentIds(JSON.stringify(consistent))?.inconsistent, false)
  assert.deepEqual(collectSettingsRepairReasons(JSON.stringify(consistent)), [])

  // BambuStudio writes '' for a preset that declares no id — a truthful unknown, not a wrong claim.
  const unknown = { nozzle_temperature: ['245'], filament_settings_id: ['Bambu PETG HF @BBL H2D 0.4 nozzle'], filament_ids: [''] }
  assert.equal(inspectProjectFilamentIds(JSON.stringify(unknown))?.inconsistent, false)
})

test('the broken project is reported through the shared reason list', () => {
  assert.deepEqual(collectSettingsRepairReasons(JSON.stringify(BROKEN)), ['filamentIds'])
  // Nothing to judge is distinct from "consistent".
  assert.equal(inspectProjectFilamentIds(null), null)
  assert.equal(inspectProjectFilamentIds('not json'), null)
  assert.deepEqual(collectSettingsRepairReasons(null), [])
})
