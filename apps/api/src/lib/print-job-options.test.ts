import assert from 'node:assert/strict'
import test from 'node:test'
import { readRecordedPrintStartOptions, serializeRecordedPrintStartOptions } from './print-job-options.js'

const CHOICE = {
  bedLevel: 'auto',
  vibrationCompensation: true,
  flowCalibration: 'auto',
  firstLayerInspection: false,
  timelapse: true,
  filamentDynamicsCalibration: true,
  nozzleOffsetCalibration: 'off'
} as const

test('a selection survives the round trip through the column', () => {
  const printOptionsJson = serializeRecordedPrintStartOptions(CHOICE)

  assert.deepEqual(readRecordedPrintStartOptions({ printOptionsJson }), CHOICE)
})

test('the recorded options outrank the legacy bedLevel column', () => {
  // The legacy Boolean disagrees on purpose: a row written after the migration has both, and
  // the lossy one must never win.
  const recorded = readRecordedPrintStartOptions({
    printOptionsJson: serializeRecordedPrintStartOptions({ ...CHOICE, bedLevel: 'auto' }),
    bedLevel: false
  })

  assert.equal(recorded?.bedLevel, 'auto')
})

test('nothing recorded reads as nothing known', () => {
  assert.equal(readRecordedPrintStartOptions({}), null)
  assert.equal(readRecordedPrintStartOptions({ printOptionsJson: null, bedLevel: null }), null)
})

test('a legacy bedLevel of false is known, but true is ambiguous and reported as unknown', () => {
  // `true` was written by `bedLevel !== 'off'`, so it means "on OR auto". Reporting it as
  // 'on' is the guess that caused issue #97; the caller's own fallback has to apply instead.
  assert.deepEqual(readRecordedPrintStartOptions({ bedLevel: false }), { bedLevel: 'off' })
  assert.equal(readRecordedPrintStartOptions({ bedLevel: true }), null)
})

test('a corrupt or foreign column reads as nothing known rather than throwing', () => {
  // A history page that 500s on one bad row is far worse than a re-print that falls back.
  assert.equal(readRecordedPrintStartOptions({ printOptionsJson: 'not json' }), null)
  assert.equal(readRecordedPrintStartOptions({ printOptionsJson: '{"bedLevel":"sideways"}' }), null)
  assert.equal(readRecordedPrintStartOptions({ printOptionsJson: '[]' }), null)
})

test('a missing selection leaves the column null rather than storing "null"', () => {
  assert.equal(serializeRecordedPrintStartOptions(null), null)
  assert.equal(serializeRecordedPrintStartOptions(undefined), null)
})
