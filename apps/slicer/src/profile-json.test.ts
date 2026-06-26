import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeBuiltinSlicerProfileJson } from './profile-json.js'

test('sanitizeBuiltinSlicerProfileJson preserves inheritance metadata', () => {
  const sanitized = JSON.parse(sanitizeBuiltinSlicerProfileJson(JSON.stringify({
    name: 'Bambu Lab P1S',
    from: 'system',
    inherits: 'fdm_bbl_3dp_001_common',
    include: ['machine_start_gcode'],
    nozzle_diameter: ['0.4']
  })))

  assert.deepEqual(sanitized, {
    name: 'Bambu Lab P1S',
    from: 'system',
    inherits: 'fdm_bbl_3dp_001_common',
    include: ['machine_start_gcode'],
    nozzle_diameter: ['0.4']
  })
})

test('sanitizeBuiltinSlicerProfileJson defaults missing `from` to system', () => {
  const sanitized = JSON.parse(sanitizeBuiltinSlicerProfileJson(JSON.stringify({
    name: 'Bambu Lab A1',
    include: ['machine_start_gcode'],
    nozzle_diameter: ['0.4']
  })))

  assert.equal(sanitized.from, 'system')
  assert.deepEqual(sanitized.include, ['machine_start_gcode'])
})