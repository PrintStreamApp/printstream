import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { seedEmptyEditorState, type EditorState } from './lib/editorModel'
import type { GizmoMode } from './editorGeometry'

installJsdomGlobals()

const { act, renderHook } = await import('@testing-library/react')
const { useEditorTextLivePlacement } = await import('./useEditorTextLivePlacement')

test('surface drag coalesces pending points, preserves the grabbed mesh, and settles one commit', async () => {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.userData.addedPartKey = 'text-1'
  group.add(mesh)
  const originalMesh = mesh
  const state = seedEmptyEditorState()
  const part = {
    key: 'text-1', soup: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1)
  }
  state.addedParts = { 1: [part] } as unknown as EditorState['addedParts']
  const pointedRef = { current: null as { point: THREE.Vector3; normal: THREE.Vector3 } | null }
  const settleRef = { current: undefined as number | undefined }
  let commits = 0
  const first = { resolve: null as ((value: ReturnType<typeof placement>) => void) | null }
  const placements: number[] = []
  const face = { id: 'face', family: 'Test', bold: false, italic: false }
  function placement(x: number) {
    return {
      face, soup: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
      position: new THREE.Vector3(x, 0, 0), rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1), rotor: group
    }
  }
  const { result, unmount } = renderHook(() => useEditorTextLivePlacement({
    modeRef: { current: 'text' as GizmoMode }, surfaceMode: 'surface',
    partKeyRef: { current: 'text-1' }, hostKeyRef: { current: 'host' },
    selectedKeyRef: { current: 'host' }, groupByKeyRef: { current: new Map([['host', group]]) },
    stateRef: { current: state }, pointedRef, settleRef,
    commitRef: { current: async () => { commits += 1 } },
    buildPlacement: async (_group, point) => {
      const x = point?.x ?? 0
      placements.push(x)
      if (placements.length === 1) {
        return await new Promise<ReturnType<typeof placement>>((resolve) => { first.resolve = resolve })
      }
      return placement(x)
    }
  }))

  const normal = new THREE.Vector3(0, 0, 1)
  act(() => {
    result.current.placeTextAt(new THREE.Vector3(0, 0, 0), normal, 'start')
    result.current.placeTextAt(new THREE.Vector3(1, 0, 0), normal, 'move')
    result.current.placeTextAt(new THREE.Vector3(2, 0, 0), normal, 'move')
    result.current.placeTextAt(new THREE.Vector3(3, 0, 0), normal, 'move')
  })
  assert.deepEqual(placements, [1])
  assert.ok(first.resolve)
  first.resolve(placement(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(placements, [1, 3])
  assert.equal(group.children[0], originalMesh)
  assert.equal(part.position.x, 3)
  assert.equal(pointedRef.current?.point.x, 3)
  assert.equal(commits, 0)

  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(commits, 1)
  act(() => {
    result.current.placeTextAt(new THREE.Vector3(4, 0, 0), normal, 'move')
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  unmount()
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(commits, 1)
})
