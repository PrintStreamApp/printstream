import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSlicePresetIncompatibilityError } from './slice-error.js'

test('lifts a filament/printer incompatibility from BambuStudio stdout', () => {
  const output = [
    '[2026-06-15 16:31:12.580538] [0x000078e4a386e600] [trace]   Initializing StaticPrintConfigs',
    '{"message":"Start to load files","plate_count":0}',
    '[2026-06-15 16:31:12.980462] [0x000078e4a386e600] [error]   run 3008: filament preset Bambu PLA Basic @BBL A1 (slot 1) is not compatible with printer Bambu Lab A1 mini 0.4 nozzle.',
    'run found error, return -5, exit...'
  ].join('\n')
  const message = formatSlicePresetIncompatibilityError(output)
  assert.ok(message, 'should produce a message')
  assert.match(message, /Bambu PLA Basic @BBL A1/)
  assert.match(message, /Bambu Lab A1 mini 0\.4 nozzle/)
  assert.doesNotMatch(message, /run 3008|\[error\]|exit\.\.\./)
})

test('returns null when there is no incompatibility line', () => {
  assert.equal(formatSlicePresetIncompatibilityError('some unrelated CLI noise\nexit 0'), null)
  assert.equal(formatSlicePresetIncompatibilityError(''), null)
})
