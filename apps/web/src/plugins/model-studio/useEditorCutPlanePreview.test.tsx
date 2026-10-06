import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { GROOVE_CUT_DEFAULTS, type CutAxis, type GrooveCut } from './lib/meshCut'
import type { GizmoMode } from './editorGeometry'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorCutPlanePreview } = await import('./useEditorCutPlanePreview')

afterEach(cleanup)
after(() => dom.window.close())

test('Cut preview publishes model bounds and one plane, then clears them on exit', () => {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 30, 40), new THREE.MeshStandardMaterial())
  mesh.position.set(12, 25, 30)
  group.add(mesh)
  group.updateMatrixWorld(true)
  const sceneRef = { current: scene }
  const groupByKeyRef = { current: new Map([['cube', group]]) }
  const targets: { plane: THREE.Object3D | null } = { plane: null }
  const targetsRef = { current: targets }
  const planeRef: { current: THREE.Mesh | null } = { current: null }
  const sizedForRef: { current: string | null } = { current: null }

  const view = renderHook(({ mode, axis }: { mode: GizmoMode; axis: CutAxis }) => {
    const [range, setCutRange] = useState<{ min: number; max: number } | null>(null)
    const [offset, setCutOffset] = useState(0)
    const [size, setCutObjectSize] = useState<{ x: number; y: number; z: number } | null>(null)
    const [groove, setGroove] = useState<GrooveCut>({ depth: 4, width: 16, ...GROOVE_CUT_DEFAULTS })
    const [soup, setCutSoup] = useState<Float32Array | null>(null)
    useEditorCutPlanePreview({
      gizmoMode: mode,
      selectedKey: 'cube',
      cutAxis: axis,
      clampedCutOffset: offset,
      rebuildToken: 0,
      sceneRef,
      groupByKeyRef,
      cutConnectorTargetsRef: targetsRef,
      cutPlaneMeshRef: planeRef,
      grooveSizedForRef: sizedForRef,
      setCutRange,
      setCutOffset,
      setCutObjectSize,
      setGroove,
      setCutSoup
    })
    return { range, offset, size, groove, soup }
  }, { initialProps: { mode: 'cut' as GizmoMode, axis: 'z' as CutAxis } })

  assert.deepEqual(view.result.current.range, { min: 10, max: 50 })
  assert.equal(view.result.current.offset, 30)
  assert.deepEqual(view.result.current.size, { x: 20, y: 30, z: 40 })
  assert.ok(view.result.current.soup?.length)
  assert.equal(targets.plane, planeRef.current)
  assert.deepEqual(scene.children, [planeRef.current])
  assert.equal(planeRef.current?.position.z, 30)
  const seededGroove = view.result.current.groove

  view.rerender({ mode: 'cut', axis: 'x' })
  assert.deepEqual(view.result.current.range, { min: 2, max: 22 })
  assert.equal(view.result.current.offset, 12)
  assert.equal(view.result.current.groove, seededGroove)
  assert.equal(planeRef.current?.rotation.y, Math.PI / 2)
  assert.deepEqual(scene.children, [planeRef.current])

  view.rerender({ mode: 'select', axis: 'x' })
  assert.equal(view.result.current.range, null)
  assert.equal(view.result.current.soup, null)
  assert.equal(targets.plane, null)
  assert.equal(planeRef.current, null)
  assert.equal(sizedForRef.current, null)
  assert.deepEqual(scene.children, [])
})
