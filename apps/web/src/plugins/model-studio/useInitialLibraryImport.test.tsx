import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()
const React = (await import('react')).default
const { cleanup, renderHook } = await import('@testing-library/react')
const { useInitialLibraryImport } = await import('./useInitialLibraryImport')

afterEach(cleanup)
after(() => { dom.window.close() })

test('waits for the scene and materials, then imports once despite StrictMode and callback changes', () => {
  const imported: string[] = []
  const { rerender } = renderHook(({ ready }) => useInitialLibraryImport({
    fileId: 'model-file',
    ready,
    importFromLibrary: async (id) => { imported.push(id) }
  }), {
    initialProps: { ready: false },
    wrapper: ({ children }) => React.createElement(React.StrictMode, null, children)
  })
  assert.deepEqual(imported, [])
  rerender({ ready: true })
  assert.deepEqual(imported, ['model-file'])
  rerender({ ready: false })
  rerender({ ready: true })
  assert.deepEqual(imported, ['model-file'])
})

test('ordinary new projects do not import a model', () => {
  let calls = 0
  renderHook(() => useInitialLibraryImport({
    ready: true,
    importFromLibrary: async () => { calls += 1 }
  }))
  assert.equal(calls, 0)
})
