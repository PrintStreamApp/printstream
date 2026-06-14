import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  areFilamentTypesCompatible,
  buildRequiredNozzleDiametersByExtruder,
  findFilamentCompatibilityIssues,
  findNozzleDiameterCompatibilityIssues,
  formatNozzleLabel,
  isPrinterModelCompatible,
  normalizeFilamentFamily,
  resolvePrinterNozzleDiameters,
  trayCanSatisfyRequirement
} from './print-compatibility.js'

test('normalizeFilamentFamily groups common material aliases into the same family', () => {
  assert.equal(normalizeFilamentFamily('PLA-CF'), 'PLA')
  assert.equal(normalizeFilamentFamily('Support PLA'), 'SUPPORT-PLA')
  assert.equal(normalizeFilamentFamily('PETG Support'), 'SUPPORT-PETG')
})

test('filament compatibility accepts matching families and rejects mismatches', () => {
  assert.equal(areFilamentTypesCompatible('PLA Basic', 'PLA-CF'), true)
  assert.equal(areFilamentTypesCompatible('PETG', 'PLA Basic'), false)
  assert.equal(
    trayCanSatisfyRequirement({ filamentId: 1, filamentType: 'PLA Basic', filamentName: 'PLA', nozzleId: 1 }, { filamentType: 'PLA-CF', nozzleId: 1 }),
    true
  )
  assert.equal(
    trayCanSatisfyRequirement({ filamentId: 1, filamentType: 'PLA Basic', filamentName: 'PLA', nozzleId: 1 }, { filamentType: 'PLA-CF', nozzleId: 0 }),
    false
  )
})

test('findFilamentCompatibilityIssues reports both type and nozzle mismatches', () => {
  const issues = findFilamentCompatibilityIssues([
    { filamentId: 11, filamentType: 'PETG', filamentName: 'PETG Black', nozzleId: 1 }
  ], new Map([
    [11, { filamentType: 'PLA Basic', label: 'Slot 3', nozzleId: 0 }]
  ]))

  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.typeMismatch, true)
  assert.equal(issues[0]?.nozzleMismatch, true)
  assert.equal(issues[0]?.trayLabel, 'Slot 3')
})

test('nozzle diameter helpers build required mappings and detect mismatches', () => {
  const required = buildRequiredNozzleDiametersByExtruder([
    { nozzleId: 0, nozzleDiameter: '0.4' },
    { nozzleId: 1, nozzleDiameter: '0.6' }
  ])
  const issues = findNozzleDiameterCompatibilityIssues(required, [
    { extruderId: 0, diameter: '0.4' },
    { extruderId: 1, diameter: '0.8' }
  ])

  assert.deepEqual(Array.from(required.entries()), [[0, '0.4'], [1, '0.6']])
  assert.deepEqual(issues, [{ extruderId: 1, requiredDiameter: '0.6', selectedDiameter: '0.8' }])
})

test('resolvePrinterNozzleDiameters prefers detected nozzles over saved selections', () => {
  const resolved = resolvePrinterNozzleDiameters({
    nozzles: [
      { extruderId: 0, diameter: '0.6', typeCode: null, material: null, flow: null, currentTemp: null, targetTemp: null },
      { extruderId: 1, diameter: '0.4', typeCode: null, material: null, flow: null, currentTemp: null, targetTemp: null }
    ]
  }, [
    { extruderId: 0, diameter: '0.4' },
    { extruderId: 2, diameter: '0.8' }
  ])

  assert.deepEqual(resolved, [
    { extruderId: 0, diameter: '0.6' },
    { extruderId: 1, diameter: '0.4' },
    { extruderId: 2, diameter: '0.8' }
  ])
})

test('formatNozzleLabel uses generic wording for single-nozzle printers', () => {
  assert.equal(formatNozzleLabel(0, 'short', 1), 'Nozzle')
  assert.equal(formatNozzleLabel(0, 'long', 1), 'nozzle')
  assert.equal(formatNozzleLabel(0, 'long', 2), 'Right nozzle')
  assert.equal(formatNozzleLabel(1, 'long', 2), 'Left nozzle')
})

test('printer model compatibility honors verified cross-model families', () => {
  assert.equal(isPrinterModelCompatible(['X1C'], 'X1E'), true)
  assert.equal(isPrinterModelCompatible(['X1C'], 'P1S'), true)
  assert.equal(isPrinterModelCompatible(['P1S'], 'X1C'), true)
  assert.equal(isPrinterModelCompatible(['X1C'], 'P1P'), false)
  assert.equal(isPrinterModelCompatible(['H2D'], 'H2DPRO'), false)
})