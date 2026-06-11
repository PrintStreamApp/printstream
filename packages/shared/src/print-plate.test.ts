import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildPlateGcodeFileHint,
  extractObservedPrintPlateIndex,
  inferObservedPrintPlateIndex,
  normalizeFallbackPlateLabel
} from './print-plate.js'

test('buildPlateGcodeFileHint derives a Metadata plate path', () => {
  assert.equal(buildPlateGcodeFileHint(24), 'Metadata/plate_24.gcode')
  assert.equal(buildPlateGcodeFileHint(null), null)
  assert.equal(buildPlateGcodeFileHint(0), null)
})

test('extractObservedPrintPlateIndex handles metadata, fallback plate labels, and dispatched archive names', () => {
  assert.equal(extractObservedPrintPlateIndex('Metadata/plate_4.gcode'), 4)
  assert.equal(extractObservedPrintPlateIndex('Best Shot Golf - plate_4.gcode.3mf'), 4)
  assert.equal(extractObservedPrintPlateIndex('/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf'), 2)
})

test('inferObservedPrintPlateIndex keeps the more explicit file hint and rejects conflicting delimited hints', () => {
  assert.equal(inferObservedPrintPlateIndex({
    jobName: 'Best Shot Golf - plate_4',
    gcodeFile: 'Metadata/plate_4.gcode'
  }), 4)

  assert.equal(inferObservedPrintPlateIndex({
    jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet',
    gcodeFile: '/CSM - Bambu - 2 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf'
  }), 2)

  assert.equal(inferObservedPrintPlateIndex({
    jobName: 'CSM - Bambu - 2 - Mast, Feeders, Counter holder, Mount feet',
    gcodeFile: '/CSM - Bambu - 3 - Mast_ Feeders_ Counter holder_ Mount feet.gcode.3mf'
  }), null)
})

test('normalizeFallbackPlateLabel only rewrites generic plate labels', () => {
  assert.equal(normalizeFallbackPlateLabel('plate_4'), 'Plate 4')
  assert.equal(normalizeFallbackPlateLabel('Plate 4'), 'Plate 4')
  assert.equal(normalizeFallbackPlateLabel('Front Nine'), 'Front Nine')
})