import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrationCommandFromOption, calibrationOption } from './printer-calibration.js'

test('calibrationOption encodes selected calibration stages into the Bambu bitmask', () => {
  assert.equal(calibrationOption({
    type: 'calibrate',
    xcam: true,
    bedLeveling: true,
    vibration: false,
    motorNoise: true,
    nozzleOffset: false,
    highTempHeatbed: true,
    nozzleClumping: false
  }), (1 << 0) | (1 << 1) | (1 << 3) | (1 << 5))
})

test('calibrationCommandFromOption rebuilds the calibration command flags from a stored bitmask', () => {
  assert.deepEqual(calibrationCommandFromOption((1 << 1) | (1 << 2) | (1 << 4) | (1 << 6)), {
    type: 'calibrate',
    xcam: false,
    bedLeveling: true,
    vibration: true,
    motorNoise: false,
    nozzleOffset: true,
    highTempHeatbed: false,
    nozzleClumping: true
  })
})