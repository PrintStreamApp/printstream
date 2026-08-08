/**
 * The gate that decides whether these hooks may call a WORKSPACE route.
 *
 * MEASURED on `/3mf-editor`: opening a project fired
 * `POST /api/slicing/profiles/resolve-process?workspace=none` and took a 403. The gates asked
 * `Boolean(sourceFileId)`, and a host with no workspace synthesizes a `LibraryFile` so the shared
 * slice-settings machinery works unchanged — its id is truthy, so the gate read it as "there is a
 * server file to resolve against" and enabled the fetch during the window before the anonymous
 * resolver is handed over.
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

installJsdomGlobals()

const { renderHook, cleanup } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const React = await import('react')
const { useProcessChangedCount, useFilamentChangedCount } = await import('./useBakedPresetChanges')

after(() => cleanup())

/** Fails the test if anything reaches the network, which is the whole point of the gate. */
function withoutNetwork<T>(run: () => T): { result: T; calls: string[] } {
  const calls: string[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String((input as { url?: string })?.url ?? input))
    throw new Error('network reached')
  }) as typeof globalThis.fetch
  try {
    return { result: run(), calls }
  } finally {
    globalThis.fetch = previous
  }
}

function wrapper({ children }: { children: React.ReactNode }) {
  // gcTime Infinity: react-query imported AFTER jsdom detects a browser and would otherwise keep a
  // ref'd 5-minute timer alive past the test (see apps/web/the development notes).
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  return React.createElement(QueryClientProvider, { client }, children)
}

test('a synthetic local file id does not enable the workspace process route', () => {
  const { calls } = withoutNetwork(() =>
    renderHook(
      () => useProcessChangedCount({
        slicerTargetId: 'bambustudio-2-7-1-62',
        processProfileId: 'project:process:0.20mm Standard @BBL H2D - Ryan',
        // The public editor's stand-in. Truthy, but there is no server file behind it.
        sourceFileId: 'local-project',
        overrides: {},
        // ...and no resolver yet: this is the window before the catalogue is ready.
        resolveConfig: undefined
      }),
      { wrapper }
    )
  )
  assert.deepEqual(calls, [], 'a host with no workspace must not call the workspace route')
})

test('a real library file id still enables it', () => {
  const { calls } = withoutNetwork(() =>
    renderHook(
      () => useProcessChangedCount({
        slicerTargetId: 'bambustudio-2-7-1-62',
        processProfileId: 'project:process:0.20mm Standard @BBL H2D - Ryan',
        sourceFileId: 'cms4yxxvn0005mpvzw8o76cen',
        overrides: {}
      }),
      { wrapper }
    )
  )
  // The inverse, so the test above cannot pass by the gate simply never enabling.
  assert.equal(calls.length, 1, 'a workspace file still resolves through the workspace route')
  assert.ok(calls[0]?.includes('/api/slicing/profiles/resolve-process'))
})

test('the same rule holds for the per-material badge', () => {
  const { calls } = withoutNetwork(() =>
    renderHook(
      () => useFilamentChangedCount({
        slicerTargetId: 'bambustudio-2-7-1-62',
        filamentProfileId: 'project:filament:Bambu PLA Basic',
        sourceFileId: 'local-project',
        projectFilamentId: 1,
        overrides: {}
      }),
      { wrapper }
    )
  )
  assert.deepEqual(calls, [])
})
