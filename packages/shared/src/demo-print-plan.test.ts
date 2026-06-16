import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  findDemoPrintDefinitionByFileName,
  getDemoPrinterActiveJob,
  getDemoPrinterRecentFinishedJob,
  getNextDemoPlaylistJob
} from './demo-print-plan.js'

test('findDemoPrintDefinitionByFileName normalizes stored demo library prefixes', () => {
  assert.equal(findDemoPrintDefinitionByFileName('1777174072904-Rail Mount.gcode.3mf')?.jobName, 'Rail Mount')
  assert.equal(findDemoPrintDefinitionByFileName('/tmp/Card Holder (3 rows).gcode.3mf')?.defaultPlate, 2)
})

test('shared demo print plan exposes the active and recent curated jobs per printer', () => {
  assert.equal(getDemoPrinterActiveJob('DEMO-X1C-001'), null)
  assert.equal(getDemoPrinterActiveJob('DEMO-H2D-001')?.jobName, 'Number Plates')
  assert.equal(getDemoPrinterActiveJob('DEMO-H2D-002')?.jobName, 'Rail Mount')
  assert.equal(getDemoPrinterActiveJob('DEMO-P1S-001')?.plate, 2)
  assert.equal(getDemoPrinterActiveJob('DEMO-X1C-002')?.jobName, 'Number Plates')
  assert.equal(getDemoPrinterActiveJob('DEMO-P1S-002')?.jobName, 'Tire Rotation Markers')
  assert.equal(getDemoPrinterRecentFinishedJob('DEMO-H2D-001')?.jobName, 'Number Plates')
  assert.equal(getDemoPrinterRecentFinishedJob('DEMO-P1S-002')?.jobName, 'Tire Rotation Markers')
})

test('getNextDemoPlaylistJob rotates through the curated demo plan', () => {
  assert.equal(getNextDemoPlaylistJob('DEMO-X1C-001', null)?.jobName, 'Card Holder (3 rows)')
  assert.equal(getNextDemoPlaylistJob('DEMO-X1C-001', 'Card Holder (3 rows)')?.jobName, 'Tire Rotation Markers')
  assert.equal(getNextDemoPlaylistJob('DEMO-H2D-002', 'Rail Mount')?.jobName, 'Number Plates')
})