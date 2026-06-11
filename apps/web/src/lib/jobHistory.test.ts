import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrintJob } from '@printstream/shared'
import { formatJobDispatchDetails } from './jobHistory.js'

function makeJob(overrides: Partial<PrintJob>): PrintJob {
  return {
    id: 'job-1',
    printerId: 'printer-1',
    printerName: 'Prototype X1C',
    jobName: 'Storage Box',
    fileId: null,
    fileName: null,
    fileSizeBytes: null,
    projectFilamentChips: [],
    plate: null,
    useAms: true,
    bedLevel: true,
    amsMapping: null,
    activity: [],
    jobKind: 'file',
    calibrationOption: null,
    result: 'success',
    progressPercent: 100,
    durationSeconds: 1800,
    thumbnailPath: null,
    snapshotPath: null,
    startedAt: '2026-05-01T00:00:00.000Z',
    finishedAt: '2026-05-01T00:30:00.000Z',
    ...overrides
  }
}

test('formatJobDispatchDetails keeps library jobs labeled as plate prints even without a file name', () => {
  assert.equal(
    formatJobDispatchDetails(makeJob({ jobKind: 'file', fileName: null, plate: null })),
    'Plate 1'
  )
})

test('formatJobDispatchDetails preserves calibration labeling', () => {
  assert.equal(
    formatJobDispatchDetails(makeJob({ jobKind: 'calibration', calibrationOption: 2 })),
    'Calibration routine'
  )
})

test('formatJobDispatchDetails labels external jobs clearly', () => {
  assert.equal(
    formatJobDispatchDetails(makeJob({ jobKind: 'external', fileName: null, plate: null })),
    'Started outside PrintStream'
  )
})

test('formatJobDispatchDetails appends library file size when available', () => {
  assert.equal(
    formatJobDispatchDetails(makeJob({ fileSizeBytes: 1_536, plate: 2 })),
    'Plate 2 - 1.5 KB'
  )
})