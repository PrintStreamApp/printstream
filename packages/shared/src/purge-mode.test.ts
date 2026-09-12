import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availablePrimeVolumeModes, parsePrimeVolumeMode } from './purge-mode.js'

test('Bambu prime-volume enum names and indices parse to one project mode', () => {
  assert.equal(parsePrimeVolumeMode('Saving'), 'Saving')
  assert.equal(parsePrimeVolumeMode(['2']), 'Fast')
  assert.equal(parsePrimeVolumeMode('unknown'), 'Default')
})

test('Fast takes the alternative slot when the machine supports it', () => {
  assert.deepEqual(availablePrimeVolumeModes({ supportsFastPurge: true, supportsPrimeSaving: true }), ['Default', 'Fast'])
  assert.deepEqual(availablePrimeVolumeModes({ supportsFastPurge: false, supportsPrimeSaving: true }), ['Default', 'Saving'])
  assert.deepEqual(availablePrimeVolumeModes({ supportsFastPurge: false, supportsPrimeSaving: false }), ['Default'])
})
