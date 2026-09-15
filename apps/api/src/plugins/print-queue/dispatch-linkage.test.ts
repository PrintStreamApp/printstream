import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PrintDispatchJob } from '@printstream/shared'
import { buildQueueDispatchLinkage } from './dispatch-linkage.js'

test('an accepted dispatch does not use its not-yet-created PrintJob foreign key', () => {
  const dispatchedAt = new Date('2026-09-14T22:00:00.000Z')
  const job = {
    id: 'dispatch-job-1',
    printJobId: 'print-job-created-later',
    printerId: 'printer-1',
    printerName: 'Printer One',
    jobName: 'plate.gcode.3mf'
  } as PrintDispatchJob

  assert.deepEqual(buildQueueDispatchLinkage(job, 'printer-1', dispatchedAt), {
    status: 'dispatching',
    lastPrinterId: 'printer-1',
    lastDispatchJobId: 'dispatch-job-1',
    lastPrintJobId: null,
    lastJobName: 'plate.gcode.3mf',
    lastDispatchedAt: dispatchedAt,
    lastResult: null,
    lastFinishedAt: null
  })
})
