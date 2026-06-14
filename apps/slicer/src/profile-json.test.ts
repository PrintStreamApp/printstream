import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeBuiltinSlicerProfileJson, sanitizeSlicerProfileJson } from './profile-json.js'

test('sanitizeSlicerProfileJson preserves inheritance metadata and writes profile type', () => {
  const sanitized = JSON.parse(sanitizeSlicerProfileJson(JSON.stringify({
    name: 'Bambu Lab P1S',
    from: 'printer',
    inherits: 'P1P',
    include: ['0.4 nozzle'],
    nozzle_diameter: ['0.4']
  }), 'machine'))

  assert.deepEqual(sanitized, {
    type: 'machine',
    name: 'Bambu Lab P1S',
    from: 'printer',
    inherits: 'P1P',
    include: ['0.4 nozzle'],
    nozzle_diameter: ['0.4']
  })
})

test('sanitizeSlicerProfileJson overrides mismatched profile type with the resolved kind', () => {
  const sanitized = JSON.parse(sanitizeSlicerProfileJson(JSON.stringify({
    type: 'filament',
    name: '0.20mm Standard @BBL H2D - Ryan',
    inherits: '0.20mm Standard @BBL H2D'
  }), 'process'))

  assert.equal(sanitized.type, 'process')
  assert.equal(sanitized.name, '0.20mm Standard @BBL H2D - Ryan')
  assert.equal(sanitized.inherits, '0.20mm Standard @BBL H2D')
})

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