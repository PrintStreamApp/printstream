import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { instanceFromStagedImport, seedEmptyEditorState } from './lib/editorModel'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorLayerHeightEditing } = await import('./useEditorLayerHeightEditing')

afterEach(cleanup)
after(() => dom.window.close())

test('layer-height edits keep one checkpoint per stroke and use the printer band', () => {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  const staged: StagedImport = {
    importId: 'test', name: 'A.stl', format: 'stl', triangleCount: 12, bounds,
    parts: [{ name: 'A.stl', triangleCount: 12, bounds, subtype: null }]
  }
  const instance = instanceFromStagedImport(staged)
  instance.key = 'A'
  instance.source = { kind: 'object' }
  instance.objectId = 3
  const initial = seedEmptyEditorState()
  initial.plates[0]!.instances = [instance]
  initial.plates[0]!.layerHeightLimits = { min: 0.1, max: 0.25 }
  let checkpoints = 0

  const view = renderHook(() => {
    const [state, setState] = useState<typeof initial | null>(initial)
    const stateRef = useRef(state)
    stateRef.current = state
    const [target, setTarget] = useState<{ key: string; objectId: number; name: string } | null>(null)
    const [mode, setMode] = useState<GizmoMode>('select')
    const groupsRef = useRef(new Map<string, THREE.Group>())
    const recordHistoryRef = useRef(() => { checkpoints += 1 })
    const editing = useEditorLayerHeightEditing({
      state,
      stateRef,
      setState,
      activePlateIndex: 1,
      nozzleDiameter: 0.4,
      nominalHeight: 0.2,
      target,
      setTarget,
      brush: null,
      groupsRef,
      recordHistoryRef,
      setMode
    })
    return { state, target, mode, ...editing }
  })

  assert.deepEqual(view.result.current.layerHeightBounds, { min: 0.1, max: 0.25 })
  act(() => view.result.current.openLayerHeightFor('missing'))
  const missingTarget = view.result.current.target
  assert.equal(missingTarget, null)
  act(() => view.result.current.openLayerHeightFor('A'))
  assert.equal(view.result.current.target?.objectId, 3)
  assert.equal(view.result.current.mode, 'layerHeight')

  act(() => view.result.current.setObjectLayerHeightProfile(3, [0.18]))
  act(() => view.result.current.setObjectLayerHeightProfile(3, [0.16], false))
  assert.deepEqual(view.result.current.state?.layerHeightProfiles?.[3], [0.16])
  assert.equal(checkpoints, 1)

  act(() => view.result.current.setObjectHeightRanges(3, [
    { minZ: 0, maxZ: 2, settings: { layer_height: '0.16' } }
  ]))
  assert.equal(view.result.current.state?.heightRanges?.[3]?.[0]?.maxZ, 2)
  assert.equal(checkpoints, 2)
})
