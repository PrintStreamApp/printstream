import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatPrinterJobDisplayName } from './printerJobName'

test('formatPrinterJobDisplayName normalizes fallback plate suffixes for active jobs', () => {
  assert.equal(
    formatPrinterJobDisplayName({
      jobName: 'Best Shot Golf - plate_4',
      gcodeFile: 'Metadata/plate_4.gcode'
    }),
    'Best Shot Golf - Plate 4'
  )
})

test('formatPrinterJobDisplayName preserves custom plate labels', () => {
  assert.equal(
    formatPrinterJobDisplayName({
      jobName: 'Best Shot Golf - Front Nine',
      gcodeFile: 'Metadata/plate_4.gcode'
    }),
    'Best Shot Golf - Front Nine'
  )
})

test('formatPrinterJobDisplayName normalizes fallback history labels from persisted plate data', () => {
  assert.equal(
    formatPrinterJobDisplayName({
      jobName: 'Best Shot Golf - plate_4',
      plate: 4
    }),
    'Best Shot Golf - Plate 4'
  )
})

test('formatPrinterJobDisplayName leaves unrelated hyphenated names alone', () => {
  assert.equal(
    formatPrinterJobDisplayName({ jobName: 'Best Shot Golf - Preview Build' }),
    'Best Shot Golf - Preview Build'
  )
})