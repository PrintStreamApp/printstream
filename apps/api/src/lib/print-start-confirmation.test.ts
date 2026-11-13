import assert from 'node:assert/strict'
import test from 'node:test'
import type { Printer } from '@printstream/shared'
import { printerEvents } from './printer-events.js'
import { watchPrintStartConfirmation, type PrintStartOutcome } from './print-start-confirmation.js'

const printer = { id: 'printer-1', name: 'Printer 1' } as Printer

function watch(jobId: string, backstopMs = 60_000) {
  const outcomes: PrintStartOutcome[] = []
  const dispose = watchPrintStartConfirmation({ jobId, backstopMs, onOutcome: (outcome) => outcomes.push(outcome) })
  return { outcomes, dispose }
}

test('the printer starting the tracked job confirms the start', () => {
  const { outcomes, dispose } = watch('job-1')
  printerEvents.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Cube' })
  dispose()
  assert.deepEqual(outcomes, ['started'])
})

test('a start the recorder declares unclaimed reports not-started, once', () => {
  const { outcomes, dispose } = watch('job-1')
  printerEvents.emit('print-job.start-unconfirmed', { printerId: 'printer-1', jobId: 'job-1' })
  printerEvents.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Cube' })
  dispose()
  assert.deepEqual(outcomes, ['not-started'])
})

// Three printers dispatched at once each wait on their own job; one printer's verdict must
// never settle another's.
test('events for another job are ignored', () => {
  const { outcomes, dispose } = watch('job-2')
  printerEvents.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Cube' })
  printerEvents.emit('print-job.start-unconfirmed', { printerId: 'printer-1', jobId: 'job-3' })
  dispose()
  assert.deepEqual(outcomes, [])
})

test('silence ends as unknown, never as a failure', async () => {
  const { outcomes } = watch('job-1', 5)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(outcomes, ['unknown'])
})

test('dispose stops listening without reporting', async () => {
  const before = printerEvents.listenerCount('print-job.started')
  const { outcomes, dispose } = watch('job-1', 5)
  dispose()
  printerEvents.emit('print-job.started', { jobId: 'job-1', printer, jobName: 'Cube' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(outcomes, [])
  assert.equal(printerEvents.listenerCount('print-job.started'), before)
})
