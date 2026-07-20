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

test('buildPerMaterialFilamentOverrides keys overrides by project slot and skips empties', () => {
  const map = buildPerMaterialFilamentOverrides([
    { projectFilamentId: 1, settingOverrides: { nozzle_temperature: ['255'] } },
    { projectFilamentId: 2, settingOverrides: {} }, // empty -> skipped
    { projectFilamentId: 3 } // no overrides -> skipped
  ])
  assert.deepEqual(map, { 1: { nozzle_temperature: ['255'] } })
})

// Regression: keyed by profileId, a slot left on the project's own preset carried no
// profileId at all, so the user's tune was silently discarded before reaching the CLI.
test('buildPerMaterialFilamentOverrides keeps a tune on a slot that has no chosen preset', () => {
  const map = buildPerMaterialFilamentOverrides([
    { projectFilamentId: 1, settingOverrides: { nozzle_temperature: ['255'] } }
  ])
  assert.deepEqual(map[1], { nozzle_temperature: ['255'] })
})

// Regression: keyed by profileId, two slots sharing one preset merged last-write-wins,
// so one slot silently printed with the other's temperature.
test('buildPerMaterialFilamentOverrides keeps two slots sharing a preset independent', () => {
  const map = buildPerMaterialFilamentOverrides([
    { projectFilamentId: 1, settingOverrides: { nozzle_temperature: ['210'], filament_flow_ratio: ['0.98'] } },
    { projectFilamentId: 2, settingOverrides: { nozzle_temperature: ['215'] } }
  ])
  assert.deepEqual(map[1], { nozzle_temperature: ['210'], filament_flow_ratio: ['0.98'] })
  assert.deepEqual(map[2], { nozzle_temperature: ['215'] })
})
