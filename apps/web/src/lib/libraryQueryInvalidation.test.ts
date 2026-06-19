import assert from 'node:assert/strict'
import test from 'node:test'
import { invalidateLibraryListQueries, invalidateLibraryQueries } from './libraryQueryInvalidation'

function recordInvalidations(): { calls: Array<unknown[] | undefined>; invalidateQueries: (input?: { queryKey?: unknown }) => Promise<undefined> } {
  const calls: Array<unknown[] | undefined> = []
  return {
    calls,
    invalidateQueries: async (input) => {
      calls.push(Array.isArray(input?.queryKey) ? input!.queryKey as unknown[] : undefined)
      return undefined
    }
  }
}

test('invalidateLibraryQueries refreshes all library query slices together', async () => {
  const { calls, invalidateQueries } = recordInvalidations()
  await invalidateLibraryQueries({ invalidateQueries })
  assert.deepEqual(calls, [
    ['library-browse'],
    ['library-files'],
    ['library-folders'],
    ['library-plates'],
    ['library-recycle-bin'],
    ['library-editor-plates'],
    ['library-editor-scene-initial'],
    ['library-editor-scenes-rest']
  ])
})

test('invalidateLibraryListQueries refreshes the list slices but NOT the editor scene caches', async () => {
  const { calls, invalidateQueries } = recordInvalidations()
  await invalidateLibraryListQueries({ invalidateQueries })
  // List slices only — refetching the editor scenes here would rebuild an open 3D view.
  assert.deepEqual(calls, [
    ['library-browse'],
    ['library-files'],
    ['library-folders'],
    ['library-plates'],
    ['library-recycle-bin']
  ])
  assert.ok(!calls.some((key) => key?.some((part) => String(part).startsWith('library-editor'))))
})