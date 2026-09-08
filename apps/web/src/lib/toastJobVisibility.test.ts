/**
 * The one window rule all three toast stacks apply. Tested here rather than per stack, because the
 * point of the module is that they cannot answer differently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TOAST_RECENT_MS, jobBelongsInToastStack } from './toastJobVisibility'

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const at = (msAgo: number) => ({ updatedAt: new Date(NOW - msAgo).toISOString() })
const verdict = (over: Partial<Parameters<typeof jobBelongsInToastStack>[1]> = {}) =>
  ({ isActive: false, isFailed: false, watchedRunning: false, ...over })

test('a failure this stack WATCHED RUN stays however long ago it happened', () => {
  // It is the one outcome carrying an action (Retry) and a reason to read, and a slice or an upload
  // routinely runs longer than the window: expiring it silenced the failure exactly for the user who
  // stepped away. It leaves when they dismiss it.
  const watched = verdict({ isFailed: true, watchedRunning: true })
  assert.equal(jobBelongsInToastStack(at(1000), watched, NOW), true)
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS * 100), watched, NOW), true)
})

test('a failure that arrived already-failed still ages out, which is what bounds a cold load', () => {
  // The dispatch list is capped at a HUNDRED finished jobs with NO time bound, and `dismissed` is
  // component state a reload clears, so pinning these would re-toast week-old sends on every load,
  // forever. The user is not waiting on a job they never saw running.
  const unwatched = verdict({ isFailed: true })
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS - 1), unwatched, NOW), true)
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS + 1), unwatched, NOW), false)
})

test('a finished job ages out whether or not it was watched', () => {
  // `jobs` comes from the server on mount, so with no window every recently-finished job would pop a
  // toast for work whose result the user has already seen.
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS - 1), verdict({ watchedRunning: true }), NOW), true)
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS + 1), verdict({ watchedRunning: true }), NOW), false)
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS + 1), verdict(), NOW), false)
})

test('an ACTIVE job is kept whatever its age, since it has not finished to be stale about', () => {
  // A long slice's `updatedAt` can sit still between progress frames; dropping it would remove the
  // only surface reporting the work that is running.
  assert.equal(jobBelongsInToastStack(at(TOAST_RECENT_MS * 5), verdict({ isActive: true }), NOW), true)
})
