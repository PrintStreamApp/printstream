import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSliceCliExitError, resolveCliReturnCode } from './cli-exit-codes.js'

test('prefers the CLI’s printed return code over exit-code arithmetic', () => {
  assert.equal(resolveCliReturnCode('run found error, return -24, exit...', 232), -24)
  // Even when the exit code was mangled in transit, the printed line wins.
  assert.equal(resolveCliReturnCode('run found error, return -17, exit...', 1), -17)
})

test('derives the return code from the exit code when the CLI printed nothing', () => {
  assert.equal(resolveCliReturnCode('', 232), -24)
  assert.equal(resolveCliReturnCode('', 239), -17)
  assert.equal(resolveCliReturnCode('', 206), -50)
})

test('never derives a return code from a signal death', () => {
  // 134-139 are 128+signal (SIGABRT..SIGSEGV) and would otherwise collide with -122..-117.
  for (const exitCode of [134, 135, 136, 137, 138, 139]) {
    assert.equal(resolveCliReturnCode('', exitCode), null)
  }
})

test('ignores exit codes outside the CLI’s own range', () => {
  assert.equal(resolveCliReturnCode('', 1), null)
  assert.equal(resolveCliReturnCode('', 0), null)
  assert.equal(resolveCliReturnCode('', null), null)
})

test('keeps the classified message shape while adding the explanation', () => {
  const message = formatSliceCliExitError('run found error, return -17, exit...', 239)
  // The API's isLikelyBuiltinProfileCompatibilityExit matches this exact prefix to trigger its
  // drop-incompatible-builtin-profiles retry — losing it silently disables that recovery.
  assert.match(message, /Slicer CLI exited with code 239/)
  assert.match(message, /not compatible with the selected printer/i)
})

test('falls back to the bare prefix for an unrecognised code', () => {
  assert.equal(formatSliceCliExitError('', 42), 'Slicer CLI exited with code 42')
  assert.equal(formatSliceCliExitError('', null), 'Slicer CLI exited with code unknown')
})

test('explains the common real-world failures', () => {
  assert.match(formatSliceCliExitError('', 206), /plate is empty, or no object sits fully inside/i)
  assert.match(formatSliceCliExitError('', 242), /ran out of memory/i)
  assert.match(formatSliceCliExitError('', 188), /cannot be printed by the extruder/i)
})
