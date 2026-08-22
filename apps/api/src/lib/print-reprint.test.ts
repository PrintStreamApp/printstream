import assert from 'node:assert/strict'
import test from 'node:test'
import { buildReprintOptions, type ReprintJobRow } from './print-reprint.js'

function makeRow(overrides: Partial<ReprintJobRow> = {}): ReprintJobRow {
  return {
    id: 'job-1',
    printerId: 'printer-1',
    sourceType: 'library',
    fileId: 'file-1',
    calibrationOption: null,
    useAms: true,
    bedLevel: null,
    plate: 1,
    amsMapping: null,
    printOptionsJson: null,
    ...overrides
  }
}

function recordedJson(options: Record<string, unknown>): string {
  return JSON.stringify({
    bedLevel: 'on',
    vibrationCompensation: false,
    flowCalibration: 'off',
    firstLayerInspection: true,
    timelapse: false,
    filamentDynamicsCalibration: false,
    nozzleOffsetCalibration: 'auto',
    ...options
  })
}

// The reported bug (issue #97): 'auto' and 'on' both persisted as `bedLevel: true`, so a
// re-print could only guess 'on' and an Auto job came back as On.
test('a print started with auto bed leveling re-prints as auto, not on', () => {
  const options = buildReprintOptions(
    makeRow({ bedLevel: true, printOptionsJson: recordedJson({ bedLevel: 'auto' }) }),
    {}
  )

  assert.equal(options.bedLevel, 'auto')
})

test('every recorded option survives an override-less re-print', () => {
  // Deliberately every value AWAY from its schema default, so a knob that silently falls
  // back to the default fails here rather than passing by coincidence.
  const options = buildReprintOptions(
    makeRow({
      printOptionsJson: recordedJson({
        bedLevel: 'off',
        vibrationCompensation: true,
        flowCalibration: 'auto',
        firstLayerInspection: false,
        timelapse: true,
        filamentDynamicsCalibration: true,
        nozzleOffsetCalibration: 'off'
      })
    }),
    {}
  )

  assert.deepEqual(
    {
      bedLevel: options.bedLevel,
      vibrationCompensation: options.vibrationCompensation,
      flowCalibration: options.flowCalibration,
      firstLayerInspection: options.firstLayerInspection,
      timelapse: options.timelapse,
      filamentDynamicsCalibration: options.filamentDynamicsCalibration,
      nozzleOffsetCalibration: options.nozzleOffsetCalibration
    },
    {
      bedLevel: 'off',
      vibrationCompensation: true,
      flowCalibration: 'auto',
      firstLayerInspection: false,
      timelapse: true,
      filamentDynamicsCalibration: true,
      nozzleOffsetCalibration: 'off'
    }
  )
})

test('an explicit override still beats the recorded choice', () => {
  const options = buildReprintOptions(
    makeRow({ printOptionsJson: recordedJson({ bedLevel: 'auto', timelapse: true }) }),
    { bedLevel: 'off' }
  )

  assert.equal(options.bedLevel, 'off')
  // Unrelated knobs are not collateral damage of overriding one.
  assert.equal(options.timelapse, true)
})

// The consent flags mean "I accept this risk right now". Replaying one would re-grant a
// bypass the user is not being shown, so they must reset even when the row carries them.
test('consent flags are never restored from the recorded options', () => {
  const options = buildReprintOptions(
    makeRow({
      printOptionsJson: recordedJson({
        allowIncompatibleFilament: true,
        allowPlateTypeMismatch: true,
        allowFilamentTrackSwitchMismatch: true,
        allowInsufficientFilament: true
      })
    }),
    {}
  )

  assert.equal(options.allowIncompatibleFilament, false)
  assert.equal(options.allowPlateTypeMismatch, false)
  assert.equal(options.allowFilamentTrackSwitchMismatch, false)
  assert.equal(options.allowInsufficientFilament, false)
})

test('a legacy row with bedLevel off re-prints with bed leveling off', () => {
  const options = buildReprintOptions(makeRow({ bedLevel: false }), {})

  assert.equal(options.bedLevel, 'off')
})

// `bedLevel: true` was written by `bedLevel !== 'off'`, so it means "on OR auto" and the
// choice is genuinely unrecoverable. Falling through to the schema default keeps legacy
// history dispatching exactly as it did before the column existed.
test('a legacy row with bedLevel true re-prints unchanged, at the schema default', () => {
  assert.equal(buildReprintOptions(makeRow({ bedLevel: true }), {}).bedLevel, 'on')
  assert.equal(buildReprintOptions(makeRow({ bedLevel: null }), {}).bedLevel, 'on')
})

test('plate and AMS mapping still come from their own columns', () => {
  const options = buildReprintOptions(
    makeRow({ plate: 3, amsMapping: '[2,5]', useAms: false }),
    {}
  )

  assert.equal(options.plate, 3)
  assert.deepEqual(options.amsMapping, [2, 5])
  assert.equal(options.useAms, false)
})

// A plate that does not use every project filament records -1 at the unused indices (the
// dispatcher prunes it that way, mirroring BambuStudio). Validating those as TRAY INDICES
// rejected the mapping and took the whole re-print down with it.
test('a job whose plate skipped a filament re-prints with its pruned mapping intact', () => {
  // Exactly what `prunePlateAmsMapping([2, 5, 7], new Set([0, 2]))` persists.
  const options = buildReprintOptions(makeRow({ amsMapping: '[2,-1,7]' }), {})

  assert.deepEqual(options.amsMapping, [2, -1, 7])
})

// `amsMapping` is optional on the wire but not nullable, so an explicit null threw and took
// the whole re-print down with it, before any of the restored options could be used.
test('a job that recorded no AMS mapping re-prints instead of failing to parse', () => {
  const options = buildReprintOptions(
    makeRow({ amsMapping: null, printOptionsJson: recordedJson({ bedLevel: 'auto' }) }),
    {}
  )

  assert.equal(options.amsMapping, undefined)
  assert.equal(options.bedLevel, 'auto')
})
