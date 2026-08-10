import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AppVersionResponse } from '@printstream/shared'
import { waitForNewBuild } from './appUpdateRestart.js'

function version(revision: string | null): AppVersionResponse {
  return { revision, shortRevision: revision?.slice(0, 7) ?? null, published: false, update: null, canApplyUpdate: false }
}

function harness(responses: Array<AppVersionResponse | null>) {
  let clock = 0
  return {
    fetchVersion: async () => responses.shift() ?? null,
    sleep: async (ms: number) => { clock += ms },
    now: () => clock,
    intervalMs: 1_000,
    timeoutMs: 10_000
  }
}

test('resolves true once a different build answers', async () => {
  const options = harness([null, version('old-build'), version('new-build')])
  assert.equal(await waitForNewBuild({ previousRevision: 'old-build', ...options }), true)
})

test('a null revision (failed poll or dying process) never counts as the new build', async () => {
  // Only nulls until the timeout: the wait must expire rather than declare victory.
  const options = harness([null, null, null, null, null, null, null, null, null, null])
  assert.equal(await waitForNewBuild({ previousRevision: 'old-build', ...options }), false)
})

test('the old build answering forever times out', async () => {
  const options = harness(Array.from({ length: 10 }, () => version('old-build')))
  assert.equal(await waitForNewBuild({ previousRevision: 'old-build', ...options }), false)
})

test('an unknown previous revision accepts the first real build that answers', async () => {
  const options = harness([version('some-build')])
  assert.equal(await waitForNewBuild({ previousRevision: null, ...options }), true)
})
