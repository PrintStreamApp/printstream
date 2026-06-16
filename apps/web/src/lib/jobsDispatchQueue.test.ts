import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintDispatchJob } from '@printstream/shared'
import { selectDispatchQueueJobs } from './jobsDispatchQueue'

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

test('selectDispatchQueueJobs keeps only queued, uploading, and failed dispatches in the queue', () => {
  const jobs = [
    makeJob({ id: 'queued', status: 'queued' }),
    makeJob({ id: 'uploading', status: 'uploading' }),
    makeJob({ id: 'failed', status: 'failed' }),
    makeJob({ id: 'sent', status: 'sent' }),
    makeJob({ id: 'cancelled', status: 'cancelled' })
  ]

  assert.deepEqual(selectDispatchQueueJobs(jobs).map((job) => job.id), ['queued', 'uploading', 'failed'])
})