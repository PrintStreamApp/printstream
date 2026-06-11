import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintDispatchJob } from '@printstream/shared'
import { isPrinterDispatchUploading } from './usePrintDispatchJobs'

function makeJob(overrides: Partial<PrintDispatchJob>): PrintDispatchJob {
  return {
    id: 'job-1',
    printJobId: 'job-1',
    printerId: 'printer-1',
    printerName: 'Printer 1',
    fileId: 'file-1',
    fileName: 'cube.gcode.3mf',
    jobName: 'cube',
    fileSizeBytes: 1024,
    sourceKind: '3mf',
    projectFilamentChips: [],
    plate: 1,
    plateName: null,
    useAms: true,
    bedLevel: 'on',
    amsMapping: null,
    status: 'queued',
    progressMessage: 'Waiting to send',
    uploadAttempt: 0,
    uploadMaxAttempts: 3,
    uploadBytesSent: 0,
    uploadTotalBytes: null,
    uploadPercent: null,
    error: null,
    createdAt: '2026-05-04T10:00:00.000Z',
    updatedAt: '2026-05-04T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    cancelRequested: false,
    ...overrides
  }
}

test('isPrinterDispatchUploading returns true only for uploading jobs on the target printer', () => {
  const jobs = [
    makeJob({ id: 'queued', printerId: 'printer-1', status: 'queued' }),
    makeJob({ id: 'uploading-other', printerId: 'printer-2', status: 'uploading' }),
    makeJob({ id: 'uploading-target', printerId: 'printer-1', status: 'uploading' })
  ]

  assert.equal(isPrinterDispatchUploading(jobs, 'printer-1'), true)
  assert.equal(isPrinterDispatchUploading(jobs, 'printer-2'), true)
  assert.equal(isPrinterDispatchUploading(jobs, 'printer-3'), false)
})

test('isPrinterDispatchUploading tolerates a missing printer id at the call site by treating it as inactive', () => {
  const jobs = [makeJob({ id: 'uploading-target', printerId: 'printer-1', status: 'uploading' })]

  assert.equal(isPrinterDispatchUploading(jobs, ''), false)
})