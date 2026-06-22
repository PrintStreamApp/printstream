process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rootPrisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import {
  isReconcilableDispatch,
  markDispatchStartAttempted,
  recordDispatchEnqueued,
  reconcileInterruptedDispatches
} from './dispatch-journal.js'

const dispatchJob = (rootPrisma as unknown as { dispatchJob: Record<string, unknown> }).dispatchJob
restorePrismaMethodsAfterEach([
  [dispatchJob, 'create'],
  [dispatchJob, 'update'],
  [dispatchJob, 'updateMany']
])

// --- The rob-1 safety rule (pure) ---

test('a pre-publish, non-terminal dispatch is reconcilable', () => {
  assert.equal(isReconcilableDispatch('queued', null), true)
  assert.equal(isReconcilableDispatch('uploading', null), true)
})

test('a dispatch that crossed the start boundary is NEVER reconcilable', () => {
  // startCommandAttemptedAt set => a real print may have started => leave it alone.
  assert.equal(isReconcilableDispatch('queued', new Date()), false)
  assert.equal(isReconcilableDispatch('uploading', new Date()), false)
})

test('terminal dispatches are not reconcilable', () => {
  for (const status of ['sent', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(isReconcilableDispatch(status, null), false, `${status} must not reconcile`)
  }
})

// --- Best-effort vs must-succeed write semantics ---

test('recordDispatchEnqueued swallows DB errors (best-effort, must not break a print)', async () => {
  dispatchJob.create = (async () => { throw new Error('db down') }) as never
  await assert.doesNotReject(() => recordDispatchEnqueued({
    id: 'd1', tenantId: 't1', printerId: 'p1', jobName: 'job', fileName: 'f.3mf', remoteName: 'f.gcode.3mf'
  }))
})

test('markDispatchStartAttempted PROPAGATES errors (the boundary must be durable before publish)', async () => {
  dispatchJob.update = (async () => { throw new Error('db down') }) as never
  await assert.rejects(() => markDispatchStartAttempted('d1'), /db down/)
})

test('reconcileInterruptedDispatches only targets pre-publish, non-terminal rows', async () => {
  let capturedWhere: { status?: { in?: string[] }; startCommandAttemptedAt?: unknown } | undefined
  dispatchJob.updateMany = (async (args: { where?: typeof capturedWhere; data?: { status?: string } }) => {
    capturedWhere = args.where
    return { count: 3 }
  }) as never
  const count = await reconcileInterruptedDispatches()
  assert.equal(count, 3)
  assert.deepEqual(capturedWhere?.status, { in: ['queued', 'uploading'] })
  assert.equal(capturedWhere?.startCommandAttemptedAt, null, 'must scope to rows that never published a start')
})
