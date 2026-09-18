import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyPluginFilamentSettings,
  effectiveFilamentSettings,
  updatePluginFilamentSettings,
  type PluginFilamentSettings
} from './pluginFilamentSettings'

test('plugin filament settings are added and removed without disturbing other slots', () => {
  let settings: PluginFilamentSettings = {
    2: { anotherPlugin: { nozzle_temperature: '220' } }
  }
  settings = updatePluginFilamentSettings(settings, 1, 'calibration', { filament_flow_ratio: '0.982' })
  assert.deepEqual(settings[1]?.calibration, { filament_flow_ratio: '0.982' })

  settings = updatePluginFilamentSettings(settings, 1, 'calibration', null)
  assert.equal(settings[1], undefined)
  assert.deepEqual(settings[2], { anotherPlugin: { nozzle_temperature: '220' } })
})

test('explicit material edits win over automatic plugin settings', () => {
  const settings: PluginFilamentSettings = {
    1: {
      calibration: { filament_flow_ratio: '0.982', nozzle_temperature: '215' },
      other: { chamber_temperature: '45' }
    }
  }
  assert.deepEqual(
    effectiveFilamentSettings(settings, 1, {
      filament_flow_ratio: '1.01',
      nozzle_temperature: '225'
    }),
    {
      filament_flow_ratio: '1.01',
      nozzle_temperature: '225',
      chamber_temperature: '45'
    }
  )
})

test('automatic flow calibration is emitted on the matching slice mapping', () => {
  const mappings = applyPluginFilamentSettings(
    [
      { projectFilamentId: 1, profileId: 'pla' },
      { projectFilamentId: 2, profileId: 'petg', settingOverrides: { nozzle_temperature: '240' } }
    ],
    { 2: { calibration: { filament_flow_ratio: '0.982' } } }
  )
  assert.equal(mappings[0]?.settingOverrides, undefined)
  assert.deepEqual(mappings[1]?.settingOverrides, {
    filament_flow_ratio: '0.982',
    nozzle_temperature: '240'
  })
})
