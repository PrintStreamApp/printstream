process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rootPrisma } from './prisma.js'
import { restorePrismaMethodsAfterEach } from '../test-utils/prisma-stubs.js'
import {
  isReconcilableDispatch,
  pruneDispatchJournal,
  markDispatchStartAttempted,
  recordDispatchEnqueued,
  recordDispatchStatus,
  reconcileInterruptedDispatches
} from './dispatch-journal.js'

const dispatchJob = (rootPrisma as unknown as { dispatchJob: Record<string, unknown> }).dispatchJob
restorePrismaMethodsAfterEach([
  [dispatchJob, 'create'],
  [dispatchJob, 'update'],
  [dispatchJob, 'updateMany'],
  [dispatchJob, 'deleteMany']
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

test('a late-committing enqueue INSERT cannot clobber a terminal UPDATE (writes serialize per id)', async () => {
  // Reproduces the live bug: enqueue and terminal writes are fired without awaiting,
  // so without per-id serialization the INSERT could commit AFTER the UPDATE (which
  // then found no row) and reseed the row to 'queued'. The chain must run the UPDATE
  // strictly after the INSERT resolves.
  const calls: string[] = []
  let resolveCreate: () => void = () => {}
  const createStarted = new Promise<void>((resolveStarted) => {
    dispatchJob.create = (async () => {
      calls.push('create')
      resolveStarted()
      await new Promise<void>((resolve) => { resolveCreate = () => resolve() })
    }) as never
  })
  dispatchJob.update = (async () => { calls.push('update') }) as never

  const enqueued = recordDispatchEnqueued({
    id: 'd9', tenantId: 't1', printerId: 'p1', jobName: 'job', fileName: 'f.3mf', remoteName: 'f.gcode.3mf'
  })
  const terminal = recordDispatchStatus('d9', 'failed', { error: 'boom', finishedAt: new Date() })

  await createStarted
  assert.deepEqual(calls, ['create'], 'the terminal UPDATE must wait for the in-flight enqueue INSERT')
  resolveCreate()
  await Promise.all([enqueued, terminal])
  assert.deepEqual(calls, ['create', 'update'], 'the UPDATE runs only after the INSERT has committed')
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

test('pruneDispatchJournal deletes only rows that finished before the retention cutoff', async () => {
  let capturedWhere: { finishedAt?: { lt?: Date } } | undefined
  dispatchJob.deleteMany = (async (args: { where?: typeof capturedWhere }) => {
    capturedWhere = args.where
    return { count: 7 }
  }) as never

  const before = Date.now()
  const { removed } = await pruneDispatchJournal(90 * 24 * 60 * 60 * 1000)

  assert.equal(removed, 7)
  const cutoff = capturedWhere?.finishedAt?.lt
  assert.ok(cutoff instanceof Date, 'scopes on finishedAt so in-flight rows (NULL) are never touched')
  const expected = before - 90 * 24 * 60 * 60 * 1000
  assert.ok(Math.abs(cutoff.getTime() - expected) < 5_000, 'cutoff is retention window ago')
})
