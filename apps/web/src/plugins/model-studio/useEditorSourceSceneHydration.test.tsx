import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import {
  libraryThreeMfSceneSchema,
  threeMfIndexSchema,
  type LibraryThreeMfScene
} from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorSourceSceneHydration } = await import('./useEditorSourceSceneHydration')

afterEach(cleanup)
after(() => dom.window.close())

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
const index = threeMfIndexSchema.parse({
  plates: [1, 2].map((plateIndex) => ({
    index: plateIndex,
    name: null,
    hasThumbnail: false,
    plateType: null,
    nozzleSizes: [],
    filaments: [],
    objects: []
  })),
  projectFilaments: [],
  compatiblePrinterModels: []
})

function scene(plateIndex: number): LibraryThreeMfScene {
  return libraryThreeMfSceneSchema.parse({
    plateIndex,
    plateName: null,
    bed: { minX: 0, maxX: 256, minY: 0, maxY: 256, plateType: null },
    parts: [{
      entryPath: '/3D/Objects/object_1.model', objectId: 1,
      transform: identity, name: 'Part', sourceFile: null,
      filamentId: 1, filamentName: null, color: null
    }],
    instances: [{
      objectId: 1, instanceId: 0, name: `Plate ${plateIndex} cube`,
      transform: identity, filamentId: 1, filamentName: null, color: null,
      parts: [{
        entryPath: '/3D/Objects/object_1.model', componentObjectId: 1, transform: identity
      }]
    }]
  })
}

function hydrationFixture() {
  return renderHook(() => {
    const [state, setState] = useState<EditorState | null>(null)
    const stateRef = useRef(state)
    stateRef.current = state
    const [activePlateIndex, setActivePlateIndex] = useState(1)
    const [rebuildToken, setRebuildToken] = useState(0)
    const [scenesByPlate, setScenesByPlate] = useState(() => new Map([[1, scene(1)]]))
    const pendingScenePlatesRef = useEditorSourceSceneHydration({
      hasNoBaseFile: false,
      sourceIndex: index,
      initialSceneSettled: true,
      scenesByPlate,
      preferredSourceIndex: 1,
      stateRef,
      setState,
      setActivePlateIndex,
      setRebuildToken
    })
    return { state, setState, activePlateIndex, rebuildToken, setScenesByPlate, pendingScenePlatesRef }
  })
}

test('late scene fills a pending plate without replacing the first plate', () => {
  const view = hydrationFixture()
  assert.equal(view.result.current.activePlateIndex, 1)
  assert.deepEqual(view.result.current.state?.plates.map((plate) => plate.instances.length), [1, 0])
  assert.equal(view.result.current.pendingScenePlatesRef.current.size, 1)

  act(() => view.result.current.setScenesByPlate(new Map([[1, scene(1)], [2, scene(2)]])))
  assert.deepEqual(view.result.current.state?.plates.map((plate) => plate.instances.length), [1, 1])
  assert.equal(view.result.current.state?.plates[1]?.instances[0]?.name, 'Plate 2 cube')
  assert.equal(view.result.current.pendingScenePlatesRef.current.size, 0)
  assert.equal(view.result.current.rebuildToken, 1)
})

test('late scene does not replace a pending plate the user already edited', () => {
  const view = hydrationFixture()
  act(() => view.result.current.setState((state) => {
    if (!state) return state
    return {
      ...state,
      plates: state.plates.map((plate) => plate.index === 2
        ? { ...plate, instances: [{ ...state.plates[0]!.instances[0]!, name: 'User edit' }] }
        : plate)
    }
  }))
  act(() => view.result.current.setScenesByPlate(new Map([[1, scene(1)], [2, scene(2)]])))
  assert.equal(view.result.current.state?.plates[1]?.instances[0]?.name, 'User edit')
  assert.equal(view.result.current.pendingScenePlatesRef.current.size, 0)
})
