import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPerMaterialFilamentOverrides, selectCliProfileFiles } from './cli-profile-selection.js'

test('drops machine presets when slicing a rewritten 3MF directly', () => {
  const selected = selectCliProfileFiles([
    { kind: 'machine' },
    { kind: 'process' },
    { kind: 'filament' }
  ], {
    rewroteProjectSettings: true
  })

  assert.deepEqual(selected, [
    { kind: 'process' },
    { kind: 'filament' }
  ])
})

test('keeps machine presets when project settings were not rewritten', () => {
  const selected = selectCliProfileFiles([
    { kind: 'machine' },
    { kind: 'process' }
  ], {
    rewroteProjectSettings: false
  })

  assert.deepEqual(selected, [
    { kind: 'machine' },
    { kind: 'process' }
  ])
})

test('buildPerMaterialFilamentOverrides keys overrides by profileId and skips empties', () => {
  const map = buildPerMaterialFilamentOverrides([
    { profileId: 'builtin:filament:PETG', settingOverrides: { nozzle_temperature: ['255'] } },
    { profileId: 'builtin:filament:PLA', settingOverrides: {} }, // empty -> skipped
    { profileId: null, settingOverrides: { nozzle_temperature: ['999'] } }, // no profile -> skipped
    { profileId: 'builtin:filament:ABS' } // no overrides -> skipped
  ])
  assert.deepEqual(map, { 'builtin:filament:PETG': { nozzle_temperature: ['255'] } })
})

test('buildPerMaterialFilamentOverrides merges two slots sharing a profileId (last write wins)', () => {
  const map = buildPerMaterialFilamentOverrides([
    { profileId: 'builtin:filament:PLA', settingOverrides: { nozzle_temperature: ['210'], filament_flow_ratio: ['0.98'] } },
    { profileId: 'builtin:filament:PLA', settingOverrides: { nozzle_temperature: ['215'] } }
  ])
  assert.deepEqual(map['builtin:filament:PLA'], { nozzle_temperature: ['215'], filament_flow_ratio: ['0.98'] })
})
