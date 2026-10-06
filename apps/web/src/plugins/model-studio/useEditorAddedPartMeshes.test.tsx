import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef } from 'react'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { rotorOf, type LayerBandUniforms } from './editorGeometry'
import { seedEmptyEditorState, type EditorAddedPart, type EditorInstance } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorAddedPartMeshes } = await import('./useEditorAddedPartMeshes')

afterEach(cleanup)
after(() => dom.window.close())

test('added-part refresh rebuilds the active group and invalidates the sidebar and gizmo', () => {
  const state = seedEmptyEditorState()
  const instance = {
    key: 'model', source: { kind: 'object' }, objectId: 7, filamentId: 1, color: '#123456'
  } as EditorInstance
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.add(rotor)
  group.userData.rotor = rotor
  const groups = new Map([['model', group]])
  const painted: string[] = []

  const view = renderHook(() => {
    const stateRef = useRef(state)
    const groupsRef = useRef(groups)
    const activePlateRef = useRef(state.plates[0]!)
    const resolveColorFilamentIdRef = useRef((id: number | null) => id)
    const filamentColorsRef = useRef<Record<number, string> | null>({ 1: '#ff0000' })
    const layerBandUniformsRef = useRef({} as LayerBandUniforms)
    return useEditorAddedPartMeshes({
      stateRef,
      groupsRef,
      activePlateRef,
      resolveColorFilamentIdRef,
      filamentColorsRef,
      layerBandUniformsRef,
      seedPaintOverlays: (_mesh, key) => { painted.push(key) }
    })
  })

  const part: EditorAddedPart = {
    key: 'aid', importId: 'aid-import', subtype: 'support_blocker', name: 'Aid',
    position: new THREE.Vector3(), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  }
  state.addedParts = { 7: [part] }
  act(() => view.result.current.refreshAddedPartMeshesRef.current())
  assert.equal(view.result.current.addedPartMeshVersion, 1)
  assert.equal(rotorOf(group).children.length, 1)
  assert.deepEqual(painted, [])

  // In-place edits need the same signal even if their caller already rebuilt the scene.
  state.addedParts[7] = []
  act(() => view.result.current.setAddedPartMeshVersion((version) => version + 1))
  assert.equal(view.result.current.addedPartMeshVersion, 2)
  act(() => view.result.current.refreshAddedPartMeshes())
  assert.equal(view.result.current.addedPartMeshVersion, 3)
  assert.equal(rotorOf(group).children.length, 0)
})
