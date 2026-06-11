import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintDispatchJob } from '@printstream/shared'
import { selectVisibleDispatchJobs } from './dispatchToastVisibility'

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

test('selectVisibleDispatchJobs hides a dismissed active dispatch toast', () => {
  const jobs = [makeJob({ id: 'job-active', status: 'uploading' })]

  assert.deepEqual(
    selectVisibleDispatchJobs(jobs, new Set(['job-active']), Date.parse('2026-05-04T10:00:01.000Z')),
    []
  )
})

test('selectVisibleDispatchJobs keeps recent undismissed jobs visible', () => {
  const jobs = [makeJob({ id: 'job-sent', status: 'sent' })]

  assert.deepEqual(
    selectVisibleDispatchJobs(jobs, new Set(), Date.parse('2026-05-04T10:00:30.000Z')).map((job) => job.id),
    ['job-sent']
  )
})