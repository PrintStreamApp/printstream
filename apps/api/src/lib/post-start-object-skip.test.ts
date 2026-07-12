import assert from 'node:assert/strict'
import test from 'node:test'
import type { Printer, PrinterStatus } from '@printstream/shared'
import { armPostStartObjectSkip } from './post-start-object-skip.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'

const printer = { id: 'printer-skip-1', model: 'P1S' } as Printer
const otherPrinter = { id: 'printer-skip-2', model: 'P1S' } as Printer

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('post-start skip publishes skip_objects once when its own tracked job starts', (t) => {
  const published: Array<Record<string, unknown>> = []
  t.mock.method(printerManager, 'publishCommand', (_printerId: string, payload: Record<string, unknown>) => {
    published.push(payload)
    return true
  })
  const baselineListeners = printerEvents.listenerCount('print-job.started')

  armPostStartObjectSkip({
    printerId: printer.id,
    printerModel: printer.model,
    dispatchJobId: 'dispatch-skip-1',
    jobName: 'Cube - Plate 1',
    objectIds: [153, 154, 153]
  })
  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners + 1)

  // A different tracked job (external print, another dispatch) must not fire the skip.
  printerEvents.emit('print-job.started', { jobId: 'other-job', printer, jobName: 'External print' })
  // Same job id on a different printer must not fire either.
  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-1', printer: otherPrinter, jobName: 'Cube - Plate 1' })
  assert.equal(published.length, 0)

  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-1', printer, jobName: 'Cube - Plate 1' })
  // Duplicate ids are deduped; the payload matches the manual skipObjects command exactly.
  assert.deepEqual(published, [{ print: { command: 'skip_objects', obj_list: [153, 154] } }])

  // One-shot: the listener is gone and a repeat start event publishes nothing more.
  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners)
  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-1', printer, jobName: 'Cube - Plate 1' })
  assert.equal(published.length, 1)
})

test('post-start skip disarms on timeout without publishing', async (t) => {
  const published: Array<Record<string, unknown>> = []
  t.mock.method(printerManager, 'publishCommand', (_printerId: string, payload: Record<string, unknown>) => {
    published.push(payload)
    return true
  })
  const baselineListeners = printerEvents.listenerCount('print-job.started')

  armPostStartObjectSkip({
    printerId: printer.id,
    printerModel: printer.model,
    dispatchJobId: 'dispatch-skip-timeout',
    jobName: 'Cube - Plate 1',
    objectIds: [153],
    timeoutMs: 5
  })
  await delay(25)

  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners)
  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-timeout', printer, jobName: 'Cube - Plate 1' })
  assert.equal(published.length, 0)
})

test('post-start skip disarm() unsubscribes before the job starts (failed start path)', (t) => {
  const published: Array<Record<string, unknown>> = []
  t.mock.method(printerManager, 'publishCommand', (_printerId: string, payload: Record<string, unknown>) => {
    published.push(payload)
    return true
  })
  const baselineListeners = printerEvents.listenerCount('print-job.started')

  const disarm = armPostStartObjectSkip({
    printerId: printer.id,
    printerModel: printer.model,
    dispatchJobId: 'dispatch-skip-disarm',
    jobName: 'Cube - Plate 1',
    objectIds: [153]
  })
  disarm()
  // Idempotent.
  disarm()

  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners)
  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-disarm', printer, jobName: 'Cube - Plate 1' })
  assert.equal(published.length, 0)
})

test('post-start skip stands down when the status shows the start-command skip was honored', (t) => {
  const published: Array<Record<string, unknown>> = []
  t.mock.method(printerManager, 'publishCommand', (_printerId: string, payload: Record<string, unknown>) => {
    published.push(payload)
    return true
  })
  // Firmware that accepted the start command's `skip_objects` reports the skipped
  // instance ids back as `s_obj` -> status.skippedObjectIds (possibly a superset,
  // e.g. after an additional manual on-device skip).
  t.mock.method(printerManager, 'getStatus', () => ({ skippedObjectIds: [153, 154, 200] } as PrinterStatus))
  const baselineListeners = printerEvents.listenerCount('print-job.started')

  armPostStartObjectSkip({
    printerId: printer.id,
    printerModel: printer.model,
    dispatchJobId: 'dispatch-skip-honored',
    jobName: 'Cube - Plate 1',
    objectIds: [153, 154]
  })
  printerEvents.emit('print-job.started', { jobId: 'dispatch-skip-honored', printer, jobName: 'Cube - Plate 1' })

  // No mid-print command was sent, and the one-shot listener is gone.
  assert.equal(published.length, 0)
  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners)
})

test('post-start skip falls back to the mid-print command when ids are missing or s_obj is unreported', (t) => {
  const published: Array<Record<string, unknown>> = []
  t.mock.method(printerManager, 'publishCommand', (_printerId: string, payload: Record<string, unknown>) => {
    published.push(payload)
    return true
  })
  // Older firmware: no s_obj ever reported -> skippedObjectIds stays null.
  const statuses: Array<PrinterStatus | undefined> = [
    { skippedObjectIds: null } as PrinterStatus,
    // Partially-honored report (one id missing) must also trigger the full fallback.
    { skippedObjectIds: [153] } as PrinterStatus,
    // No status at all (printer cache miss).
    undefined
  ]
  for (const [index, status] of statuses.entries()) {
    published.length = 0
    const getStatus = t.mock.method(printerManager, 'getStatus', () => status)
    armPostStartObjectSkip({
      printerId: printer.id,
      printerModel: printer.model,
      dispatchJobId: `dispatch-skip-fallback-${index}`,
      jobName: 'Cube - Plate 1',
      objectIds: [153, 154]
    })
    printerEvents.emit('print-job.started', { jobId: `dispatch-skip-fallback-${index}`, printer, jobName: 'Cube - Plate 1' })
    // The full requested list is sent (re-skipping an already-skipped id is harmless).
    assert.deepEqual(published, [{ print: { command: 'skip_objects', obj_list: [153, 154] } }], `status case ${index}`)
    getStatus.mock.restore()
  }
})

test('post-start skip with no object ids is a no-op (no listener armed)', () => {
  const baselineListeners = printerEvents.listenerCount('print-job.started')
  const disarm = armPostStartObjectSkip({
    printerId: printer.id,
    printerModel: printer.model,
    dispatchJobId: 'dispatch-skip-empty',
    jobName: 'Cube - Plate 1',
    objectIds: []
  })
  assert.equal(printerEvents.listenerCount('print-job.started'), baselineListeners)
  disarm()
})
