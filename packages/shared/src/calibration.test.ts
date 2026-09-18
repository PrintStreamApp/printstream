import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  calibrationParametersSchema,
  flowRatioFromOffset,
  pressureAdvanceFromHeight,
  resolveBestCalibrationValue,
  saveCalibrationResultSchema,
  submitCalibrationMeasurementSchema
} from './calibration.js'

const calibratedFilament = {
  spoolId: 'spool-1',
  brand: 'Polymaker',
  filamentType: 'PLA',
  materialSubtype: 'PLA Pro',
  colorName: 'Silver'
}

test('saved calibration resolution prefers a spool and then the most specific identity', () => {
  const candidates = [
    { scope: 'identity' as const, value: 0.95, spoolId: null, brand: 'Polymaker', filamentType: null, materialSubtype: null, colorName: null },
    { scope: 'identity' as const, value: 0.97, spoolId: null, brand: 'Polymaker', filamentType: 'PLA', materialSubtype: 'PLA Pro', colorName: null },
    { scope: 'spool' as const, value: 0.982, spoolId: 'spool-1', brand: null, filamentType: null, materialSubtype: null, colorName: null }
  ]
  assert.equal(resolveBestCalibrationValue(candidates, calibratedFilament)?.value, 0.982)
  assert.equal(
    resolveBestCalibrationValue(candidates, { ...calibratedFilament, spoolId: null })?.value,
    0.97
  )
})

test('PETG and PETG-CF calibrations remain separate material types', () => {
  const filament = { ...calibratedFilament, filamentType: 'PETG-CF', materialSubtype: 'PETG-CF' }
  const plainPetg = {
    ...filament, scope: 'identity' as const, spoolId: null, value: 0.98,
    filamentType: 'PETG', materialSubtype: null
  }
  assert.equal(resolveBestCalibrationValue([plainPetg], filament), null)
  assert.equal(resolveBestCalibrationValue([{ ...plainPetg, filamentType: 'PETG-CF' }], filament)?.value, 0.98)
})

test('identity calibration saves require at least one explicit match field', () => {
  assert.equal(saveCalibrationResultSchema.safeParse({
    scope: 'identity',
    match: { brand: false, filamentType: false, materialSubtype: false, colorName: false }
  }).success, false)
  assert.equal(saveCalibrationResultSchema.safeParse({
    scope: 'identity',
    match: { brand: true, filamentType: false, materialSubtype: false, colorName: false },
    identity: { brand: 'Polymaker', filamentType: 'PETG', materialSubtype: null, colorName: null }
  }).success, true)
})

test('flowRatioFromOffset applies BambuStudio percent formula', () => {
  assert.equal(flowRatioFromOffset(1, 0), 1)
  assert.equal(Number(flowRatioFromOffset(1, 5).toFixed(4)), 1.05)
  assert.equal(Number(flowRatioFromOffset(0.98, -5).toFixed(4)), 0.931)
  assert.equal(Number(flowRatioFromOffset(0.95, 10).toFixed(4)), 1.045)
})

test('pressureAdvanceFromHeight steps K once per mm of Z and clamps', () => {
  assert.equal(pressureAdvanceFromHeight(0, 0.002, 8), 0.016)
  // Reads the floor of the measured height.
  assert.equal(pressureAdvanceFromHeight(0, 0.002, 8.9), 0.016)
  // Clamped into [0, 2].
  assert.equal(pressureAdvanceFromHeight(0, 0.002, 5000), 2)
})

test('pressure-advance parameters require end K above start K by at least one step', () => {
  assert.equal(
    calibrationParametersSchema.safeParse({ kind: 'pressureAdvance', startK: 0, endK: 0.1, step: 0.002 }).success,
    true
  )
  assert.equal(
    calibrationParametersSchema.safeParse({ kind: 'pressureAdvance', startK: 0.1, endK: 0.1, step: 0.002 }).success,
    false
  )
})

test('flow parameters accept a coarse sweep and reject an out-of-range flow ratio', () => {
  assert.equal(
    calibrationParametersSchema.safeParse({
      kind: 'flowRatio',
      pass: 1,
      currentFlowRatio: 0.98,
      offsets: [-20, -10, 0, 10, 20]
    }).success,
    true
  )
  assert.equal(
    calibrationParametersSchema.safeParse({ kind: 'flowRatio', pass: 1, currentFlowRatio: 2.5, offsets: [-5, 5] }).success,
    false
  )
})

test('tower parameter ranges validate their physical bounds and direction', () => {
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'temperature', startTemperature: 230, endTemperature: 190, step: 5 }).success, true)
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'temperature', startTemperature: 190, endTemperature: 230, step: 5 }).success, false)
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'maxVolumetricSpeed', startSpeed: 5, endSpeed: 40, step: 5 }).success, true)
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'maxVolumetricSpeed', startSpeed: 5, endSpeed: 61, step: 5 }).success, false)
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'vfa', startSpeed: 40, endSpeed: 200, step: 10 }).success, true)
  assert.equal(calibrationParametersSchema.safeParse({ kind: 'retraction', startLength: 0, endLength: 2, step: 0.1 }).success, true)
})

test('measurement + save requests validate per kind and scope', () => {
  assert.equal(
    submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'pressureAdvance', bestHeightMm: 8 } }).success,
    true
  )
  assert.equal(
    submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'flowRatio', selectedOffset: -5 } }).success,
    true
  )
  assert.equal(submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'temperature', selectedTemperature: 215 } }).success, true)
  assert.equal(submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'maxVolumetricSpeed', selectedSpeed: 24 } }).success, true)
  assert.equal(submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'vfa', selectedSpeed: 120 } }).success, true)
  assert.equal(submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'retraction', selectedLength: 0.8 } }).success, true)
  // The run's own spool remains a valid implicit narrow target for older clients;
  // current clients can send several explicit spool targets.
  assert.equal(saveCalibrationResultSchema.safeParse({ scope: 'spool' }).success, true)
  assert.equal(saveCalibrationResultSchema.safeParse({ scope: 'spool', spoolIds: ['spool-1', 'spool-2'] }).success, true)
  assert.equal(saveCalibrationResultSchema.safeParse({ scope: 'identity' }).success, false)
  assert.equal(
    saveCalibrationResultSchema.safeParse({ scope: 'identity', match: { brand: true, filamentType: true, materialSubtype: false, colorName: false } }).success,
    true
  )
})
