/** Priority, reservation, and anonymous fairness coverage for shared slicer slots. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { SlicingExecutionScheduler, type SlicingExecutionTier } from './slicing-execution-scheduler.js'

function ticket(id: string, tier: SlicingExecutionTier, started: string[], actorKey?: string) {
  return { id, tier, actorKey, createdAt: new Date(`2026-01-01T00:00:0${id.length}.000Z`), start: () => started.push(id) }
}

test('paid jobs jump ahead of queued free and anonymous jobs', () => {
  const started: string[] = []
  const runnable = new SlicingExecutionScheduler(1, 1)
  runnable.enqueue(ticket('active', 'paid', started))
  runnable.enqueue(ticket('anon', 'anonymous', started, 'ip-a'))
  runnable.enqueue(ticket('free', 'free', started))
  runnable.enqueue(ticket('paid', 'paid', started))
  runnable.complete('active')
  assert.deepEqual(started, ['active', 'paid'])
  runnable.complete('paid')
  assert.deepEqual(started, ['active', 'paid', 'free'])
})

test('anonymous work cannot occupy the reserved workspace slot', () => {
  const scheduler = new SlicingExecutionScheduler(2, 1)
  const started: string[] = []
  scheduler.enqueue(ticket('anon-a', 'anonymous', started, 'ip-a'))
  scheduler.enqueue(ticket('anon-b', 'anonymous', started, 'ip-b'))
  assert.deepEqual(started, ['anon-a'])
  scheduler.enqueue(ticket('paid', 'paid', started))
  assert.deepEqual(started, ['anon-a', 'paid'])
})

test('lighter anonymous actors go first within the public lane', () => {
  const scheduler = new SlicingExecutionScheduler(1, 1)
  const started: string[] = []
  scheduler.enqueue(ticket('first-a', 'anonymous', started, 'ip-a'))
  scheduler.enqueue(ticket('second-a', 'anonymous', started, 'ip-a'))
  scheduler.enqueue(ticket('first-b', 'anonymous', started, 'ip-b'))
  scheduler.complete('first-a')
  assert.deepEqual(started, ['first-a', 'first-b'])
})
