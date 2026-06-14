import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCliProfileFiles } from './cli-profile-selection.js'

test('drops machine presets when slicing a rewritten 3MF directly', () => {
  const selected = selectCliProfileFiles([
    { kind: 'machine' },
    { kind: 'process' },
    { kind: 'filament' }
  ], {
    rewroteProjectSettings: true,
    useEstimateModeMachineSwitch: false
  })

  assert.deepEqual(selected, [
    { kind: 'process' },
    { kind: 'filament' }
  ])
})

test('keeps machine presets when estimate-mode machine switch is active', () => {
  const selected = selectCliProfileFiles([
    { kind: 'machine' },
    { kind: 'process' }
  ], {
    rewroteProjectSettings: true,
    useEstimateModeMachineSwitch: true
  })

  assert.deepEqual(selected, [
    { kind: 'machine' },
    { kind: 'process' }
  ])
})

test('keeps machine presets when project settings were not rewritten', () => {
  const selected = selectCliProfileFiles([
    { kind: 'machine' },
    { kind: 'process' }
  ], {
    rewroteProjectSettings: false,
    useEstimateModeMachineSwitch: false
  })

  assert.deepEqual(selected, [
    { kind: 'machine' },
    { kind: 'process' }
  ])
})