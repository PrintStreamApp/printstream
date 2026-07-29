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

test('invalidateLibraryQueries refreshes the library slices but never the editor scene caches', async () => {
  const { calls, invalidateQueries } = recordInvalidations()
  await invalidateLibraryQueries({ invalidateQueries })
  assert.deepEqual(calls, [
    ['library-browse'],
    ['library-files'],
    ['library-folders'],
    ['library-plates'],
    ['library-recycle-bin'],
    // The "changed vs preset" badges are keyed by file ID, which a save keeps — without this
    // bust a save that rewrote project_settings serves the pre-save count until staleTime.
    ['process-baked-changes'],
    ['filament-baked-changes'],
    // Held at staleTime Infinity and keyed by file id, so only an explicit bust refreshes it —
    // and its value reaches a slice request, not just a badge.
    ['slice-project-process-carry']
  ])
  // Load-bearing absence. The editor reads its project from an archive downloaded ONCE per
  // session, so refetching these after a save re-reads the PRE-save bytes and stores them as
  // fresh — poisoning the cache for the next editor session rather than refreshing anything.
  // `EditorView` removes these keys on unmount instead.
  assert.ok(!calls.some((key) => key?.some((part) => String(part).startsWith('library-editor'))))
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