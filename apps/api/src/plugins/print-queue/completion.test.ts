import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Printer } from '@printstream/shared'
import { usePrismaStubs } from '../../test-utils/prisma-stubs.js'
import { rootPrisma } from '../../lib/prisma.js'
import { printerManager } from '../../lib/printer-manager.js'
import { createQueueCompletionHandlers } from './completion.js'

const stub = usePrismaStubs()

const logger = { info() {}, warn() {}, error() {} }
const printer = { id: 'printer-1' } as unknown as Printer

function handlers(isEnabledForTenant: (tenantId: string | null) => boolean = () => true) {
  return createQueueCompletionHandlers({ isEnabledForTenant, logger })
}

function stubItem(item: { id: string; quantity: number; completedCount: number } | null) {
  const updates: Array<Record<string, unknown>> = []
  stub(printerManager, 'getTenantId', () => 'tenant-1')
  stub(rootPrisma.queueItem, 'findFirst', async () => item)
  stub(rootPrisma.queueItem, 'update', async ({ data }: { data: Record<string, unknown> }) => {
    updates.push(data)
    return {}
  })
  return updates
}

test('a successful final copy marks the item done', async () => {
  const updates = stubItem({ id: 'q1', quantity: 1, completedCount: 0 })
  await handlers().onFinished({ jobId: 'job-1', printer, jobName: 'plate.gcode.3mf', result: 'success' })
  assert.equal(updates.length, 1)
  assert.equal(updates[0]?.completedCount, 1)
  assert.equal(updates[0]?.status, 'done')
  assert.equal(updates[0]?.lastResult, 'success')
})

test('a successful non-final copy returns the item to the queue and clears dispatch linkage', async () => {
  const updates = stubItem({ id: 'q1', quantity: 3, completedCount: 0 })
  await handlers().onFinished({ jobId: 'job-1', printer, jobName: 'plate.gcode.3mf', result: 'success' })
  assert.equal(updates[0]?.completedCount, 1)
  assert.equal(updates[0]?.status, 'queued')
  assert.equal(updates[0]?.lastPrintJobId, null)
  assert.equal(updates[0]?.lastDispatchJobId, null)
})

test('a failed print moves the item to failed for manual re-queue', async () => {
  const updates = stubItem({ id: 'q1', quantity: 2, completedCount: 0 })
  await handlers().onFinished({ jobId: 'job-1', printer, jobName: 'plate.gcode.3mf', result: 'failed' })
  assert.equal(updates[0]?.status, 'failed')
  assert.equal(updates[0]?.lastResult, 'failed')
})

test('a print start moves a dispatching item to printing', async () => {
  const updates = stubItem({ id: 'q1', quantity: 1, completedCount: 0 })
  await handlers().onStarted({ jobId: 'job-1', printer, jobName: 'plate.gcode.3mf' })
  assert.equal(updates[0]?.status, 'printing')
  assert.equal(updates[0]?.lastPrintJobId, 'job-1')
})

test('no matching queue item is a no-op', async () => {
  const updates = stubItem(null)
  await handlers().onFinished({ jobId: 'job-x', printer, jobName: 'plate.gcode.3mf', result: 'success' })
  assert.equal(updates.length, 0)
})

test('events for a disabled tenant are ignored', async () => {
  const updates = stubItem({ id: 'q1', quantity: 1, completedCount: 0 })
  await handlers(() => false).onFinished({ jobId: 'job-1', printer, jobName: 'plate.gcode.3mf', result: 'success' })
  assert.equal(updates.length, 0)
})
