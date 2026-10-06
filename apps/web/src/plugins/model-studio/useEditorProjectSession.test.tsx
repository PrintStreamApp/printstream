import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { EditorProjectSource } from './lib/editorProjectSource'
import type { EditorImportStore } from './lib/editorImportStore'
import type { EditorSaveTarget } from './lib/editorSaveTarget'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/test/library' })
const React = (await import('react')).default
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { cleanup, renderHook, waitFor } = await import('@testing-library/react')
const { useEditorProjectSession } = await import('./useEditorProjectSession')

afterEach(cleanup)
after(() => dom.window.close())

test('editor project session loads from one supplied source and drops its stale cache on close', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const calls: string[] = []
  const source = {
    loadIndex: async () => { calls.push('index'); return { plates: [] } },
    loadEmbeddedPresets: async () => { calls.push('presets'); return [] },
    loadProjectSettings: async () => { calls.push('settings'); return '{}' },
    loadProjectAuxiliaries: async () => { calls.push('auxiliaries'); return {} },
    dispose: () => { calls.push('dispose') }
  } as unknown as EditorProjectSource
  const saveTarget = { isLibraryBacked: false } as EditorSaveTarget
  const importStore = {} as EditorImportStore
  client.setQueryData(['library-file', 'file-1'], { currentVersionNumber: 1 })
  client.setQueryData(['library-editor-scene-initial', 'file-1'], { stale: true })

  const { result, rerender, unmount } = renderHook(
    ({ auxiliariesOpen }) => useEditorProjectSession({
      baseFileId: 'file-1',
      baseVersionId: null,
      resourceBase: '/api/library/file-1',
      hasNoBaseFile: false,
      projectAuxiliariesOpen: auxiliariesOpen,
      projectSourceProp: source,
      importStore,
      saveTarget
    }),
    {
      initialProps: { auxiliariesOpen: false },
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
  )

  await waitFor(() => assert.equal(result.current.platesQuery.isSuccess, true))
  await waitFor(() => assert.equal(result.current.projectSettingsQuery.isSuccess, true))
  assert.equal(result.current.projectSource, source)
  assert.equal(result.current.effectiveSaveTarget, saveTarget)
  assert.equal(result.current.savesToLocalFile, true)
  assert.equal(calls.includes('auxiliaries'), false)

  rerender({ auxiliariesOpen: true })
  await waitFor(() => assert.equal(result.current.projectAuxiliariesQuery.isSuccess, true))
  assert.deepEqual(calls.sort(), ['auxiliaries', 'index', 'presets', 'settings'])

  unmount()
  assert.equal(client.getQueryData(['library-file', 'file-1']), undefined)
  assert.equal(client.getQueryData(['library-editor-scene-initial', 'file-1']), undefined)
  assert.equal(calls.includes('dispose'), false, 'a host-supplied source keeps its caller-owned lifetime')
  client.clear()
})
