import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrationValueLabel } from './runPresentation'

test('band labels hide floating-point noise and include their measurement units', () => {
  assert.equal(calibrationValueLabel('retraction', 3 * 0.1), '0.3 mm')
  assert.equal(calibrationValueLabel('retraction', 6 * 0.1), '0.6 mm')
  assert.equal(calibrationValueLabel('retraction', 7 * 0.1), '0.7 mm')
  assert.equal(calibrationValueLabel('maxVolumetricSpeed', 3 * 0.1), '0.3 mm3/s')
  assert.equal(calibrationValueLabel('temperature', 240), '240 C')
  assert.equal(calibrationValueLabel('vfa', 100), '100 mm/s')
})
