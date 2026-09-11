import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyManualFilamentMapToModelSettings,
  buildManualNozzleAssignment,
  clearManualFilamentMapFromModelSettings,
  clearManualFilamentMapFromProjectSettings,
  modelSettingsCarriesManualFilamentMap,
  readAuthoredManualFilamentMap
} from './manual-filament-map.js'

test('manual nozzle assignment accepts slice-target mappings and covers unassigned slots', () => {
  const assignment = buildManualNozzleAssignment({
    physical_extruder_map: ['1', '0'],
    filament_colour: ['#FFFFFF', '#000000', '#00FF00']
  }, [
    { projectFilamentId: 1, toolheadId: 'nozzle-1' },
    { projectFilamentId: 2, toolheadId: 'nozzle-0' },
    { projectFilamentId: 3 }
  ])
  assert.deepEqual(assignment, { filament_map_mode: 'Manual', filament_map: ['1', '2', '1'] })
})

test('manual nozzle assignment also accepts parsed filament metadata', () => {
  const assignment = buildManualNozzleAssignment(
    { physical_extruder_map: ['0', '1'] },
    new Map([[1, { nozzleId: 1 }], [2, { nozzleId: 0 }]])
  )
  assert.deepEqual(assignment?.filament_map, ['2', '1'])
})

test('model settings receives one escaped manual map on every plate', () => {
  const rewritten = applyManualFilamentMapToModelSettings(
    '<config><plate><metadata key="filament_map_mode" value="Auto For Flush"/></plate><plate><metadata key="name" value="Two"/></plate></config>',
    '2 1'
  )
  assert.equal(rewritten.match(/key="filament_map_mode" value="Manual"/g)?.length, 2)
  assert.equal(rewritten.match(/key="filament_maps" value="2 1"/g)?.length, 2)
  assert.ok(!rewritten.includes('Auto For Flush'))
})

test('authored manual maps are complete and valid', () => {
  assert.deepEqual(readAuthoredManualFilamentMap({
    filament_map_mode: 'Manual',
    filament_map: ['2', '1'],
    filament_settings_id: ['PLA', 'PETG']
  }), ['2', '1'])
  assert.equal(readAuthoredManualFilamentMap({ filament_map_mode: 'Auto For Flush' }), null)
  assert.throws(
    () => readAuthoredManualFilamentMap({ filament_map_mode: 'Manual', filament_map: ['1'], filament_type: ['PLA', 'PETG'] }),
    /1 of 2 material slots/
  )
  assert.throws(
    () => readAuthoredManualFilamentMap({
      filament_map_mode: 'Manual',
      filament_map: ['3'],
      physical_extruder_map: ['1', '0']
    }),
    /extruder this machine does not have/
  )
})

test('clears inherited manual maps from project and every plate', () => {
  assert.deepEqual(clearManualFilamentMapFromProjectSettings({
    filament_map_mode: 'Manual',
    filament_map: ['2', '1'],
    filament_type: ['PLA', 'PETG']
  }), { filament_type: ['PLA', 'PETG'] })

  const source = '<config><plate><metadata value="Manual" key="filament_map_mode"/><metadata value="2 1" key="filament_maps"/></plate><plate><metadata key="name" value="Two"/><metadata key="filament_map_mode" value="Manual"/></plate></config>'
  assert.equal(modelSettingsCarriesManualFilamentMap(source), true)
  const cleared = clearManualFilamentMapFromModelSettings(source)
  assert.equal(modelSettingsCarriesManualFilamentMap(cleared), false)
  assert.doesNotMatch(cleared, /key="filament_maps"/)
  assert.match(cleared, /key="name" value="Two"/)
})
