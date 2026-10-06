import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { ReactNode } from 'react'
import { threeMfIndexSchema, type LibraryThreeMfScene } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorProjectSource } from './lib/editorProjectSource'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { loadRemainingPlateScenes, useEditorPlateSceneQueries } = await import('./useEditorPlateSceneQueries')

afterEach(cleanup)
after(() => dom.window.close())

test('remaining scenes load with bounded concurrency and omit metadata-free plates', async () => {
  let active = 0
  let maximum = 0
  const signal = new AbortController().signal
  const scenes = await loadRemainingPlateScenes([1, 2, 3, 4, 5], async (plateIndex, passedSignal) => {
    assert.equal(passedSignal, signal)
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return plateIndex === 2 ? null : { plateIndex } as LibraryThreeMfScene
  }, signal)
  assert.equal(maximum, 3)
  assert.deepEqual([...scenes.keys()].sort((a, b) => a - b), [1, 3, 4, 5])
})

test('opening source plate stays frozen when the host follows live plate selection', () => {
  const sourceIndex = threeMfIndexSchema.parse({
    plates: [1, 2].map((index) => ({
      index, name: null, hasThumbnail: false, plateType: null,
      nozzleSizes: [], filaments: [], objects: []
    })),
    projectFilaments: [],
    compatiblePrinterModels: []
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const projectSource = {} as EditorProjectSource
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(
    ({ initialPlateIndex }: { initialPlateIndex: number }) => useEditorPlateSceneQueries({
      sourceIndex,
      initialPlateIndex,
      baseFileId: null,
      baseVersionId: null,
      targetPrinterModel: null,
      hasNoBaseFile: true,
      projectSource
    }),
    { initialProps: { initialPlateIndex: 2 }, wrapper }
  )
  assert.equal(view.result.current.preferredPlateIndex, 2)
  assert.deepEqual(view.result.current.restPlateIndices, [1])
  view.rerender({ initialPlateIndex: 1 })
  assert.equal(view.result.current.preferredPlateIndex, 2)
  assert.deepEqual(view.result.current.restPlateIndices, [1])
  client.clear()
})
