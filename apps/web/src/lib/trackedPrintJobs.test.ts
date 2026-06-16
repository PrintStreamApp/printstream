import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintDispatchJob, PrintJob } from '@printstream/shared'
import {
  mapActiveDispatchJobsByPrinter,
  mapLatestActivePrintJobsByPrinter,
  mapLatestFinishedPrintJobsByPrinter,
  selectDispatchQueueWithPrintJobs
} from './trackedPrintJobs'

function makePrintJob(overrides: Partial<PrintJob>): PrintJob {
  return {
    id: 'job-1',
    printerId: 'printer-1',
    printerName: 'Printer 1',
    jobName: 'Widget',
    fileName: 'widget.gcode.3mf',
    fileId: 'file-1',
    fileSizeBytes: 1024,
    projectFilamentChips: [],
    plate: 1,
    useAms: true,
    bedLevel: true,
    amsMapping: [0],
    progressPercent: null,
    durationSeconds: null,
    startedAt: '2026-05-04T10:00:00.000Z',
    finishedAt: null,
    result: 'unknown',
    thumbnailPath: null,
    snapshotPath: null,
    jobKind: 'file',
    calibrationOption: null,
    activity: [],
    ...overrides
  }
}

function makeDispatchJob(overrides: Partial<PrintDispatchJob>): PrintDispatchJob {
  return {
    id: 'dispatch-1',
    printJobId: 'job-1',
    printerId: 'printer-1',
    printerName: 'Printer 1',
    fileId: 'file-1',
    fileName: 'widget.gcode.3mf',
    jobName: 'Widget',
    fileSizeBytes: 1024,
    sourceKind: '3mf',
    projectFilamentChips: [],
    plate: 1,
    plateName: null,
    useAms: true,
    bedLevel: 'on',
    amsMapping: null,
    status: 'queued',
    progressMessage: 'Waiting to upload',
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

test('selectDispatchQueueWithPrintJobs links queue rows to their durable print jobs', () => {
  const linkedJobs = selectDispatchQueueWithPrintJobs(
    [makePrintJob({ id: 'job-1', jobName: 'Linked job' })],
    [makeDispatchJob({ id: 'dispatch-1', printJobId: 'job-1' })]
  )

  assert.equal(linkedJobs.length, 1)
  assert.equal(linkedJobs[0]?.dispatchJob.id, 'dispatch-1')
  assert.equal(linkedJobs[0]?.printJob?.jobName, 'Linked job')
})

test('selectDispatchQueueWithPrintJobs keeps queue rows even when the jobs response lags behind', () => {
  const linkedJobs = selectDispatchQueueWithPrintJobs([], [makeDispatchJob({ id: 'dispatch-1', printJobId: 'job-missing' })])

  assert.equal(linkedJobs.length, 1)
  assert.equal(linkedJobs[0]?.dispatchJob.printJobId, 'job-missing')
  assert.equal(linkedJobs[0]?.printJob, null)
})

test('mapActiveDispatchJobsByPrinter keeps the first active dispatch per printer and links the tracked job', () => {
  const activeDispatchJobs = mapActiveDispatchJobsByPrinter(
    [makePrintJob({ id: 'job-1', jobName: 'First job' }), makePrintJob({ id: 'job-2', printerId: 'printer-2', printerName: 'Printer 2', jobName: 'Second job' })],
    [
      makeDispatchJob({ id: 'dispatch-1', printJobId: 'job-1', printerId: 'printer-1' }),
      makeDispatchJob({ id: 'dispatch-2', printJobId: 'job-ignored', printerId: 'printer-1', status: 'uploading' }),
      makeDispatchJob({ id: 'dispatch-3', printJobId: 'job-2', printerId: 'printer-2', status: 'uploading' }),
      makeDispatchJob({ id: 'dispatch-4', printJobId: 'job-finished', printerId: 'printer-3', status: 'sent' })
    ]
  )

  assert.deepEqual(Array.from(activeDispatchJobs.keys()), ['printer-1', 'printer-2'])
  assert.equal(activeDispatchJobs.get('printer-1')?.dispatchJob.id, 'dispatch-1')
  assert.equal(activeDispatchJobs.get('printer-1')?.printJob?.jobName, 'First job')
  assert.equal(activeDispatchJobs.get('printer-2')?.dispatchJob.id, 'dispatch-3')
})

test('mapLatestFinishedPrintJobsByPrinter keeps the first finished job for each printer', () => {
  const latestFinishedJobs = mapLatestFinishedPrintJobsByPrinter([
    makePrintJob({ id: 'active-job', printerId: 'printer-1', finishedAt: null }),
    makePrintJob({ id: 'finished-1', printerId: 'printer-1', finishedAt: '2026-05-04T10:05:00.000Z', result: 'success' }),
    makePrintJob({ id: 'finished-2', printerId: 'printer-1', finishedAt: '2026-05-04T09:05:00.000Z', result: 'failed' }),
    makePrintJob({ id: 'finished-3', printerId: 'printer-2', printerName: 'Printer 2', finishedAt: '2026-05-04T10:06:00.000Z', result: 'success' })
  ])

  assert.equal(latestFinishedJobs.get('printer-1')?.id, 'finished-1')
  assert.equal(latestFinishedJobs.get('printer-2')?.id, 'finished-3')
})

test('mapLatestActivePrintJobsByPrinter keeps the first unfinished job for each printer', () => {
  const latestActiveJobs = mapLatestActivePrintJobsByPrinter([
    makePrintJob({ id: 'active-1', printerId: 'printer-1', finishedAt: null }),
    makePrintJob({ id: 'active-2', printerId: 'printer-1', finishedAt: null, jobName: 'Older active' }),
    makePrintJob({ id: 'finished-1', printerId: 'printer-1', finishedAt: '2026-05-04T10:05:00.000Z', result: 'success' }),
    makePrintJob({ id: 'active-3', printerId: 'printer-2', printerName: 'Printer 2', finishedAt: null })
  ])

  assert.equal(latestActiveJobs.get('printer-1')?.id, 'active-1')
  assert.equal(latestActiveJobs.get('printer-2')?.id, 'active-3')
})