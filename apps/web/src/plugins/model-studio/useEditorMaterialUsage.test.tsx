import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorProjectSource } from './lib/editorProjectSource'
import type { useEditorProjectSession } from './useEditorProjectSession'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/library' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { act, cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { useEditorMaterialUsage } = await import('./useEditorMaterialUsage')

afterEach(cleanup)
after(() => dom.window.close())

test('source materials stay guarded until this archive scan and scene merge are both ready', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const archive = { entryNames: () => [] }
  const firstSource = { archive: () => archive, loadIndex: async () => ({}) } as unknown as EditorProjectSource
  const secondSource = { archive: () => archive, loadIndex: async () => ({}) } as unknown as EditorProjectSource
  const platesQuery = {
    isSuccess: true,
    data: { projectFilaments: [{ id: 1 }, { id: 2 }] }
  } as unknown as ReturnType<typeof useEditorProjectSession>['platesQuery']
  const sliceConfig = {
    projectFilaments: [{ projectFilamentId: 1 }, { projectFilamentId: 2 }]
  } as SliceSettingsController

  const { result, rerender } = renderHook(
    ({ projectSource }) => useEditorMaterialUsage({
      state: null,
      sliceConfig,
      platesQuery,
      projectSource,
      hasNoBaseFile: false
    }),
    {
      initialProps: { projectSource: firstSource },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
  )

  assert.deepEqual([...result.current.unverifiedFilamentIds], [1, 2])
  await act(async () => { result.current.setSourceScenesReadyFor(firstSource) })
  await waitFor(() => assert.equal(result.current.unverifiedFilamentIds.size, 0))

  rerender({ projectSource: secondSource })
  assert.deepEqual([...result.current.unverifiedFilamentIds], [1, 2])
  await act(async () => { result.current.setSourceScenesReadyFor(secondSource) })
  await waitFor(() => assert.equal(result.current.unverifiedFilamentIds.size, 0))
  client.clear()
})

test('cached plate data opens the new source before scanning its colour paint', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const archive = { entryNames: () => [] }
  let opened = false
  let opens = 0
  const source = {
    archive: () => opened ? archive : null,
    loadIndex: async () => { opens += 1; opened = true; return {} }
  } as unknown as EditorProjectSource
  const platesQuery = {
    isSuccess: true,
    data: { projectFilaments: [{ id: 1 }] }
  } as unknown as ReturnType<typeof useEditorProjectSession>['platesQuery']
  const sliceConfig = {
    projectFilaments: [{ projectFilamentId: 1 }]
  } as SliceSettingsController

  const { result } = renderHook(() => useEditorMaterialUsage({
    state: null,
    sliceConfig,
    platesQuery,
    projectSource: source,
    hasNoBaseFile: false
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })

  assert.deepEqual([...result.current.unverifiedFilamentIds], [1])
  await act(async () => { result.current.setSourceScenesReadyFor(source) })
  await waitFor(() => assert.equal(result.current.unverifiedFilamentIds.size, 0))
  assert.equal(opens, 1)
  client.clear()
})
