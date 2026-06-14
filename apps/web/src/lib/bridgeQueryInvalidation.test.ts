import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidateBridgeQueries } from './bridgeQueryInvalidation'

test('invalidateBridgeQueries refreshes bridge-dependent queries together', async () => {
  const calls: Array<{ queryKey?: unknown[] }> = []

  await invalidateBridgeQueries({
    invalidateQueries: async (input) => {
      calls.push({ queryKey: Array.isArray(input?.queryKey) ? input.queryKey : undefined })
      return undefined
    }
  })

  assert.deepEqual(calls, [
    { queryKey: ['auth-bootstrap'] },
    { queryKey: ['bridges'] },
    { queryKey: ['settings-bridges'] },
    { queryKey: ['library-browse'] }
  ])
})