import assert from 'node:assert/strict'
import test from 'node:test'
import type { PrintDispatchJob } from '@printstream/shared'
import { isActiveDispatchJob, isCancellableDispatchJob, selectVisibleDispatchJobs } from './dispatchToastVisibility'

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
    selectVisibleDispatchJobs(jobs, new Set(['job-active']), new Set(), Date.parse('2026-05-04T10:00:01.000Z')),
    []
  )
})

test('selectVisibleDispatchJobs keeps recent undismissed jobs visible', () => {
  const jobs = [makeJob({ id: 'job-sent', status: 'sent' })]

  assert.deepEqual(
    selectVisibleDispatchJobs(jobs, new Set(), new Set(), Date.parse('2026-05-04T10:00:30.000Z')).map((job) => job.id),
    ['job-sent']
  )
})
// `starting` = the start command is out and the printer has not confirmed it. It must keep the
// toast up (so a start the printer ignores surfaces there as a failure rather than after a
// "sent" toast has auto-dismissed) without offering a Cancel that can no longer do anything.
test('a starting send stays in flight but can no longer be cancelled', () => {
  const starting = makeJob({ status: 'starting' })
  assert.equal(isActiveDispatchJob(starting), true)
  assert.equal(isCancellableDispatchJob(starting), false)
  assert.deepEqual(selectVisibleDispatchJobs([starting], new Set(), new Set()).map((job) => job.id), ['job-1'])
  assert.equal(isCancellableDispatchJob(makeJob({ status: 'uploading' })), true)
})
