/**
 * The seeding decision behind a project's machine overrides.
 *
 * The sequence that made "apply, save, reopen" lose the override twice over: React Query answers a
 * remount from CACHE first, so the hook sees the pre-save `{}` before the fresh answer lands. A
 * guard that latches on that empty answer spends its single seed attempt on it and refuses the real
 * one, and the user's saved setting silently reads as absent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { machineOverrideSeedDecision } from './useProjectMachineOverrides'

const KEY = 'file|v1|machine|target'

test('a stale empty answer does not consume the seed the fresh answer needs', () => {
  // What a remount sees first: the cached pre-save answer.
  assert.equal(
    machineOverrideSeedDecision({ overrides: {}, seededKey: null, key: KEY, hasCurrentEdits: false }),
    'wait',
    'an empty answer must not latch: a refetch may still fill it in'
  )
  // The refetch lands. This is the case that was being refused.
  assert.equal(
    machineOverrideSeedDecision({ overrides: { support_air_filtration: '1' }, seededKey: null, key: KEY, hasCurrentEdits: false }),
    'seed'
  )
})

test('the user\'s own edits are never clobbered, and seeding happens once per file version', () => {
  assert.equal(
    machineOverrideSeedDecision({ overrides: { printable_height: '300' }, seededKey: null, key: KEY, hasCurrentEdits: true }),
    'settle',
    'an in-session edit wins over the file, and settles so it cannot be re-decided'
  )
  assert.equal(
    machineOverrideSeedDecision({ overrides: { printable_height: '300' }, seededKey: KEY, key: KEY, hasCurrentEdits: false }),
    'wait',
    'already seeded for this key'
  )
  // A SAVE changes the file version, so the key changes and the new content seeds again.
  assert.equal(
    machineOverrideSeedDecision({ overrides: { support_air_filtration: '1' }, seededKey: KEY, key: 'file|v2|machine|target', hasCurrentEdits: false }),
    'seed'
  )
})

test('no answer yet is never a decision', () => {
  assert.equal(
    machineOverrideSeedDecision({ overrides: undefined, seededKey: null, key: KEY, hasCurrentEdits: false }),
    'wait'
  )
})
