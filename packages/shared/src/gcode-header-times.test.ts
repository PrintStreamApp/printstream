/**
 * Prepare time is a SUBTRACTION between two numbers on one header line, and every way of getting it
 * wrong produces a plausible-looking figure rather than an error.
 *
 * The bug this closes shipped as "Prepare time 2h 13m" beside a real 4h 56m print estimate, on a
 * slice whose actual prepare phase was 5m 24s. Nothing threw; the number was simply a different
 * quantity, in a different unit, about a different subject (the CLI's own wall clock in
 * milliseconds). So the cases below pin the arithmetic against a REAL header, and pin every input
 * shape where the honest answer is "say nothing".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseGcodeDuration, parseGcodeHeaderTimes } from './gcode-header-times.js'

/** Verbatim from a BambuStudio 2.8.2.61 slice (Best Shot Golf, H2D, 163 layers). */
const REAL_HEADER = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.08.02.61',
  '; model printing time: 4h 51m 5s; total estimated time: 4h 56m 29s',
  '; total layer number: 163',
  '; HEADER_BLOCK_END'
].join('\n')

test('parseGcodeDuration reads every unit BambuStudio emits', () => {
  assert.equal(parseGcodeDuration('45s'), 45)
  assert.equal(parseGcodeDuration('35m 21s'), 35 * 60 + 21)
  assert.equal(parseGcodeDuration('4h 51m 5s'), 4 * 3600 + 51 * 60 + 5)
  assert.equal(parseGcodeDuration('1d 2h 3m 4s'), 86400 + 2 * 3600 + 3 * 60 + 4)
})

test('parseGcodeDuration reports nothing for text carrying no unit', () => {
  // Null, not 0: "the header did not state this" and "this takes no time" are different claims,
  // and only the second may be shown to a user.
  assert.equal(parseGcodeDuration(''), null)
  assert.equal(parseGcodeDuration('   '), null)
  assert.equal(parseGcodeDuration('unknown'), null)
})

test('prepare time is the difference between the two halves of the real header line', () => {
  const times = parseGcodeHeaderTimes(REAL_HEADER)
  assert.equal(times.totalSeconds, 17789, 'total estimated time = machine.time')
  assert.equal(times.modelPrintingSeconds, 17465, 'model printing time = machine.time - prepare_time')
  // 5m 24s. The value this replaced reported 7980 for the same slice, because it was the CLI's
  // wall-clock MILLISECONDS and was read as seconds: 2h 13m of "prepare" on an 8-second load.
  assert.equal(times.prepareSeconds, 324)
})

test('the total is found even though Bambu puts it mid-line after the model time', () => {
  // The two figures share one comment separated by `;`, so a regex anchored at the start of the
  // comment finds only the first, and a value pattern that does not stop at `;` swallows both.
  const times = parseGcodeHeaderTimes('; model printing time: 1h 0m 0s; total estimated time: 1h 10m 0s')
  assert.equal(times.modelPrintingSeconds, 3600)
  assert.equal(times.totalSeconds, 4200)
  assert.equal(times.prepareSeconds, 600)
})

test('a PrusaSlicer-lineage header yields a total but no prepare', () => {
  // It states no model-printing half. Inferring "then prepare is zero" would describe a printer
  // that starts extruding the instant you press go.
  const times = parseGcodeHeaderTimes('; estimated printing time (normal mode) = 2h 5m 30s')
  assert.equal(times.totalSeconds, 2 * 3600 + 5 * 60 + 30)
  assert.equal(times.modelPrintingSeconds, null)
  assert.equal(times.prepareSeconds, null)
})

test('a header with neither figure reports nothing rather than zero', () => {
  const times = parseGcodeHeaderTimes('; HEADER_BLOCK_START\n; total layer number: 163\n')
  assert.deepEqual(times, { totalSeconds: null, modelPrintingSeconds: null, prepareSeconds: null })
})

test('an impossible subtraction is refused', () => {
  // Two halves that did not come from one slice (a concatenated file, a partial match). A negative
  // prepare time cannot be true, so report nothing rather than a number that is certainly wrong.
  const times = parseGcodeHeaderTimes('; model printing time: 5h 0m 0s; total estimated time: 1h 0m 0s')
  assert.equal(times.prepareSeconds, null)
})

test('a zero-length prepare phase is reported, not swallowed', () => {
  // Distinct from the null cases above: here the engine positively stated that the two are equal.
  const times = parseGcodeHeaderTimes('; model printing time: 1h 0m 0s; total estimated time: 1h 0m 0s')
  assert.equal(times.prepareSeconds, 0)
})
