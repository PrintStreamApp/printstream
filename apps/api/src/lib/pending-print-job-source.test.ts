import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  clearAllPendingPrintJobSources,
  consumePendingPrintJobSource,
  registerPendingPrintJobSource
} from './pending-print-job-source.js'

afterEach(() => {
  clearAllPendingPrintJobSources()
})

test('consumePendingPrintJobSource returns the next registered start metadata once', () => {
  registerPendingPrintJobSource('printer-1', {
    jobKind: 'calibration',
    jobId: null,
    fileId: null,
    fileName: null,
    fileSizeBytes: null,
    sourceKind: null,
    plate: null,
    useAms: null,
    bedLevel: null,
    amsMapping: null,
    calibrationOption: (1 << 1) | (1 << 2)
  })

  assert.deepEqual(consumePendingPrintJobSource('printer-1'), {
    jobKind: 'calibration',
    jobId: null,
    fileId: null,
    fileName: null,
    fileSizeBytes: null,
    sourceKind: null,
    plate: null,
    useAms: null,
    bedLevel: null,
    amsMapping: null,
    calibrationOption: (1 << 1) | (1 << 2)
  })
  assert.equal(consumePendingPrintJobSource('printer-1'), null)
})