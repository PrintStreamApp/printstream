import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSliceEngineCrashError, formatSlicePresetIncompatibilityError } from './slice-error.js'

const OVERHANG_CRASH_OUTPUT = [
  '{"message":"Slicing begins","plate_count":1,"plate_index":1,"plate_percent":4,"total_percent":6}',
  '{"message":"Detect overhangs for auto-lift","plate_count":1,"plate_index":1,"plate_percent":71,"total_percent":66}',
  'Segmentation fault'
].join('\n')

test('formatSliceEngineCrashError names the crash stage for a post-load segfault', () => {
  const message = formatSliceEngineCrashError(OVERHANG_CRASH_OUTPUT, 139)
  assert.ok(message, 'should produce a message')
  assert.match(message, /Detect overhangs for auto-lift/)
  assert.match(message, /engine exit 139/)
  // Must NOT contain the transient-crash text the API retry predicate keys on.
  assert.doesNotMatch(message, /exited with code 13[4-9]/i)
})

test('formatSliceEngineCrashError returns null for a load/teardown crash (stays retryable)', () => {
  const loadCrash = [
    '[2026-07-15 22:51:31] [trace]   Initializing StaticPrintConfigs',
    '{"message":"Prepare slicing","total_percent":3}',
    'Segmentation fault (core dumped)'
  ].join('\n')
  assert.equal(formatSliceEngineCrashError(loadCrash, 139), null)
  assert.equal(formatSliceEngineCrashError('', 139), null)
})

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
