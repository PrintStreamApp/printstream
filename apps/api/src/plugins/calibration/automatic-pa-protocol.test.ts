import assert from 'node:assert/strict'
import { test } from 'node:test'
import { automaticPaSetup, automaticPaStartFields, automaticPaResult } from './automatic-pa-protocol.js'

const setup = automaticPaSetup({ nozzle_temperature: ['220'], textured_plate_temp: ['55'], filament_max_volumetric_speed: ['12'], filament_id: 'GFA00', setting_id: 'preset' }, 'Textured PEI Plate', 2)
const result = { result: 'success', nozzle_diameter: '0.4', filaments: [{ tray_id: 2, filament_id: 'GFA00', k_value: '0.025', n_coef: '1.4', confidence: 0 }] }

test('automatic calibration freezes actual preset temperatures and starts only the chosen tray', () => {
  assert.equal(setup.bedTemperature, 55)
  assert.deepEqual((automaticPaStartFields(setup, '0.4', 0, 2).filaments as unknown[]).length, 1)
  assert.throws(() => automaticPaSetup({}, 'Textured PEI Plate', 2), /valid automatic calibration settings/)
  assert.throws(() => automaticPaSetup({}, null, 2), /supported build plate/)
})

test('result matching requires tray, filament, nozzle and successful confidence code', () => {
  assert.deepEqual(automaticPaResult(result, setup, '0.4'), { k: 0.025, n: 1.4 })
  assert.equal(automaticPaResult(result, { ...setup, trayIndex: 3 }, '0.4'), null)
  assert.equal(automaticPaResult(result, { ...setup, filamentId: 'other' }, '0.4'), null)
  assert.equal(automaticPaResult(result, setup, '0.6'), null)
  assert.equal(automaticPaResult({ result: 'fail' }, setup, '0.4'), null)
  assert.throws(() => automaticPaResult({ ...result, filaments: [{ ...result.filaments[0], confidence: 1 }] }, setup, '0.4'), /reliably/)
  assert.throws(() => automaticPaResult({ ...result, filaments: [{ ...result.filaments[0], k_value: '' }] }, setup, '0.4'), /invalid/)
})
