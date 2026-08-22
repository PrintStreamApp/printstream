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
    ['slice-project-process-carry'],
    // Single-file metadata DTOs (name, version counter, repair flags) — NOT a scene cache.
    // Skipping it left the editor's repair banner gating on pre-repair flags, so a successful
    // repair read as having done nothing.
    ['library-file']
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
/**
 * Every `library-*` query key any surface actually declares, read out of the sources
 * rather than restated here, checked against what the invalidator busts.
 *
 * Reading the files is the point: an earlier version of this test listed the keys as
 * literals and asserted those, which passed just as happily when a dialog was re-spelled
 * back to an unreachable key. It claimed to be the regression cover for exactly the
 * silent failure it could not see.
 */
test('every library query key a surface declares is reachable from the list invalidator', async () => {
  const { readFile } = await import('node:fs/promises')
  const { calls, invalidateQueries } = recordInvalidations()
  await invalidateLibraryListQueries({ invalidateQueries })
  const bustedPrefixes = new Set(calls.map((key) => String(key?.[0])))

  // Surfaces whose keys must be reachable. Editor caches are deliberately NOT here:
  // they are excluded from the list invalidator on purpose (see the header above).
  const sources = [
    'apps/web/src/components/LibraryFilePickerDialog.tsx',
    'apps/web/src/components/LibraryDestinationDialog.tsx',
    'apps/web/src/components/printers/LibraryPickerModal.tsx',
    'apps/web/src/plugins/orders/components/OrderDialogs.tsx'
  ]

  const declared: Array<{ source: string; prefix: string }> = []
  for (const source of sources) {
    const text = await readFile(new URL(`../../../../${source}`, import.meta.url), 'utf8')
    for (const match of text.matchAll(/queryKey:\s*\[\s*'(library-[a-z-]+)'/g)) {
      declared.push({ source, prefix: match[1]! })
    }
  }

  assert.ok(declared.length >= 6, `expected to find library query keys in the picker sources, found ${declared.length}`)
  for (const { source, prefix } of declared) {
    assert.ok(
      bustedPrefixes.has(prefix),
      `${source} declares ['${prefix}', ...], which invalidateLibraryListQueries does not bust`
    )
  }
})
