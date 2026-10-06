import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import {
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorInstance
} from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorObjectOrdering } = await import('./useEditorObjectOrdering')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
const staged: StagedImport = {
  importId: 'test', name: 'A.stl', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'A.stl', triangleCount: 12, bounds, subtype: null }]
}

function object(id: number, name: string): EditorInstance {
  const instance = instanceFromStagedImport(staged)
  instance.source = { kind: 'object' }
  instance.objectId = id
  instance.name = name
  return instance
}

test('sidebar reorders checkpoint only real object and part changes', () => {
  const a = object(3, 'A')
  a.parts = [0, 1, 2].map((partIndex) => ({
    entryPath: '3D/3dmodel.model',
    componentObjectId: 20 + partIndex,
    partIndex,
    transform: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    filamentId: 1,
    name: `P${partIndex}`,
    color: null,
    subtype: null
  }))
  const initial = seedEmptyEditorState()
  initial.plates[0]!.instances = [a, object(9, 'B')]
  let checkpoints = 0
  const view = renderHook(() => {
    const [state, setState] = useState<typeof initial | null>(initial)
    const stateRef = useRef(state)
    stateRef.current = state
    const ordering = useEditorObjectOrdering({
      stateRef,
      setState,
      recordHistory: () => { checkpoints += 1 }
    })
    return { state, ...ordering }
  })

  act(() => view.result.current.handleReorderObject(3, 9))
  assert.equal(checkpoints, 0)
  act(() => view.result.current.handleReorderObject(9, 3))
  assert.deepEqual(view.result.current.state?.plates[0]?.instances.map((instance) => instance.name), ['B', 'A'])
  assert.equal(checkpoints, 1)

  act(() => view.result.current.handleReorderPart(3, 2, 0))
  assert.deepEqual(view.result.current.state?.partOrder?.[3], [2, 0, 1])
  assert.equal(checkpoints, 2)
  act(() => view.result.current.handleReorderPart(3, 2, 0))
  assert.equal(checkpoints, 2)
})
