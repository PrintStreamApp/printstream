import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidateLibraryQueries } from './libraryQueryInvalidation'

test('invalidateLibraryQueries refreshes all library query slices together', async () => {
  const calls: Array<{ queryKey?: unknown[] }> = []

  await invalidateLibraryQueries({
    invalidateQueries: async (input) => {
      calls.push({ queryKey: Array.isArray(input?.queryKey) ? input.queryKey : undefined })
      return undefined
    }
  })

  assert.deepEqual(calls, [
    { queryKey: ['library-browse'] },
    { queryKey: ['library-files'] },
    { queryKey: ['library-folders'] },
    { queryKey: ['library-plates'] },
    { queryKey: ['library-recycle-bin'] }
  ])
})