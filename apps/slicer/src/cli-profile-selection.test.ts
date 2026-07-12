import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCliProfileFiles } from './cli-profile-selection.js'

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
