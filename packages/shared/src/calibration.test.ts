import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  calibrationParametersSchema,
  flowRatioFromOffset,
  pressureAdvanceFromHeight,
  saveCalibrationResultSchema,
  submitCalibrationMeasurementSchema
} from './calibration.js'

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

test('measurement + save requests validate per kind and scope', () => {
  assert.equal(
    submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'pressureAdvance', bestHeightMm: 8 } }).success,
    true
  )
  assert.equal(
    submitCalibrationMeasurementSchema.safeParse({ measurement: { kind: 'flowRatio', selectedOffset: -5 } }).success,
    true
  )
  // Identity scope requires match criteria; spool scope does not.
  assert.equal(saveCalibrationResultSchema.safeParse({ scope: 'spool' }).success, true)
  assert.equal(saveCalibrationResultSchema.safeParse({ scope: 'identity' }).success, false)
  assert.equal(
    saveCalibrationResultSchema.safeParse({ scope: 'identity', match: { brand: true, filamentType: true, materialSubtype: false, colorName: false } }).success,
    true
  )
})
