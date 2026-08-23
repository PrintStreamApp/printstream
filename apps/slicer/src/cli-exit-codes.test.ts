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
  // drop-incompatible-builtin-profiles retry: losing it silently disables that recovery.
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

/**
 * The invalid-value failure names WHICH settings the engine rejected.
 *
 * BambuStudio's own check (`DynamicPrintConfig::validate`, run by the CLI before slicing) returns a
 * map keyed by option name and the CLI prints every entry to stderr before exiting -18. Without
 * lifting those keys out, our message says a setting value is rejected and leaves the user to guess
 * which of several hundred it is.
 *
 * Deliberately reads the ENGINE's answer rather than re-deriving one from our own option bounds.
 * Two implementations of the same rule is precisely the shape that keeps producing bugs here, and
 * this one would be a check disagreeing with the engine it is meant to predict.
 */
test('an invalid setting value names the settings the engine rejected', () => {
  const output = [
    'Param values in 3mf/config error: ',
    'layer_height: Invalid value: must be greater than 0',
    'wall_loops: Invalid value: out of range',
    'run found error, return -18, exit...'
  ].join('\n')
  const message = formatSliceCliExitError(output, 238)
  assert.match(message, /Slicer CLI exited with code 238/)
  assert.match(message, /setting value the slicer rejects/i)
  assert.match(message, /layer_height/)
  assert.match(message, /wall_loops/)
})

test('the setting list is only added for the failure it belongs to', () => {
  // A different failure that happens to mention a setting name must not grow a rejected-values list.
  const message = formatSliceCliExitError('run found error, return -17, exit...', 239)
  assert.doesNotMatch(message, /rejected/i)
})
