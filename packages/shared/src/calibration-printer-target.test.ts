import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calibrationMatchesPrinter, resolveTargetedCalibrationValue, type CalibrationResult } from './calibration.js'

const filament = { spoolId: 'spool', brand: 'Acme', filamentType: 'PLA', materialSubtype: null, colorName: null }
const base = { id: 'model', kind: 'flowRatio', value: 0.98, scope: 'identity', printerModel: 'P1S', nozzleDiameter: '0.4',
  spoolId: null, brand: 'Acme', filamentType: 'PLA', materialSubtype: null, colorName: null } as CalibrationResult

test('legacy and multiple-model rules require a matching model and nozzle', () => {
  assert.equal(calibrationMatchesPrinter(base, { printerModel: 'P1S', nozzleDiameter: '0.4' }), true)
  assert.equal(calibrationMatchesPrinter(base, { printerModel: 'P1P', nozzleDiameter: '0.4' }), false)
  const multi: CalibrationResult = { ...base, printerTarget: { scope: 'models', models: ['P1S', 'P1P'] } }
  assert.equal(calibrationMatchesPrinter(multi, { printerModel: 'P1P', nozzleDiameter: '0.4' }), true)
  assert.equal(calibrationMatchesPrinter(multi, { printerModel: 'P1P', nozzleDiameter: '0.6' }), false)
})

test('Wilma-only rules never apply to another printer or a model-only slice', () => {
  const wilma: CalibrationResult = { ...base, value: 1.02, printerTarget: { scope: 'printers', printerIds: ['wilma'] } }
  const target = { printerModel: 'P1S', nozzleDiameter: '0.4' }
  assert.equal(calibrationMatchesPrinter(wilma, target), false)
  assert.equal(calibrationMatchesPrinter(wilma, { ...target, printerId: 'fred' }), false)
  assert.equal(calibrationMatchesPrinter(wilma, { ...target, printerId: 'wilma' }), true)
  assert.equal(resolveTargetedCalibrationValue([base, wilma], filament, { ...target, printerId: 'wilma' }), wilma)
  assert.equal(resolveTargetedCalibrationValue([base, wilma], filament, { ...target, printerId: 'fred' }), base)
})

test('printer specificity precedes filament specificity, then spool beats identity within its tier', () => {
  const modelSpool: CalibrationResult = { ...base, scope: 'spool', spoolId: 'spool' }
  const exact: CalibrationResult = { ...base, printerTarget: { scope: 'printers', printerIds: ['wilma'] } }
  const exactSpool: CalibrationResult = { ...exact, scope: 'spool', spoolId: 'spool' }
  const target = { printerId: 'wilma', printerModel: 'P1S', nozzleDiameter: '0.4' }
  assert.equal(resolveTargetedCalibrationValue([modelSpool, exact], filament, target), exact)
  assert.equal(resolveTargetedCalibrationValue([exact, exactSpool], filament, target), exactSpool)
  assert.equal(resolveTargetedCalibrationValue([modelSpool, { ...exact, brand: 'Other' }], filament, target), modelSpool)
})
