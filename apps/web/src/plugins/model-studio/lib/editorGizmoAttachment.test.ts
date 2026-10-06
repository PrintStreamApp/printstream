import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import { attachEditorGizmo } from './editorGizmoAttachment'
import type { GizmoMode, SelectedTransform } from '../editorGeometry'
import type { PartRef } from './selectionModel'

const readout: SelectedTransform = {
  position: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
  scalePct: { x: 100, y: 100, z: 100 }
}

test('object, body, and part selections attach to their proper pivot and seed the readout', () => {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  body.position.x = 5
  group.add(body)
  const added = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  added.userData.addedPartKey = 'added-1'
  const proxy = new THREE.Object3D()
  let attached: THREE.Object3D | null = null
  let detached = 0
  let modeSet: string | null = null
  let highlighted: THREE.Group | null = null
  let panelTarget: THREE.Object3D | null = null
  let panelValue: SelectedTransform | null = null
  const transform = {
    attach: (object: THREE.Object3D) => { attached = object },
    detach: () => { detached += 1; attached = null },
    setMode: (mode: string) => { modeSet = mode }
  } as unknown as TransformControls
  const options = (part: PartRef | null, mode: GizmoMode = 'translate') => ({
    transform, selectedKey: 'host', groups: new Map([['host', group]]), part, mode,
    pivotProxy: proxy, allSelectedKeys: () => ['host'],
    setSelectionHighlight: (next: THREE.Group | null) => { highlighted = next },
    computeSelectedTransform: (object: THREE.Object3D) => { panelTarget = object; return readout },
    setSelectedTransform: (value: SelectedTransform | null) => { panelValue = value }
  })

  attachEditorGizmo(options(null))
  assert.equal(attached, proxy)
  assert.equal(proxy.position.x, 5, 'object pivots on printable geometry, not its origin')
  assert.equal(highlighted, group)
  assert.equal(panelTarget, group)
  assert.equal(panelValue, readout)
  assert.equal(modeSet, 'translate')

  attachEditorGizmo(options({ objectId: 1, member: { kind: 'body' } }, 'rotate'))
  assert.equal(attached, proxy)
  assert.equal(proxy.position.x, 5)
  assert.equal(highlighted, null)
  assert.equal(panelTarget, group)
  assert.equal(modeSet, 'rotate')

  group.add(added)
  attachEditorGizmo(options({ objectId: 1, member: { kind: 'added', key: 'added-1' } }))
  assert.equal(attached, added)
  assert.equal(panelTarget, added)
  assert.equal(highlighted, null)

  attachEditorGizmo(options(null, 'text'))
  assert.equal(attached, null)
  assert.equal(detached, 1)
  assert.equal(panelTarget, group)
})

test('no selected group detaches the gizmo and clears the transform readout', () => {
  let detached = false
  let cleared = false
  attachEditorGizmo({
    transform: { detach: () => { detached = true } } as unknown as TransformControls,
    selectedKey: null, groups: new Map(), part: null, mode: 'translate',
    pivotProxy: null, allSelectedKeys: () => [],
    setSelectionHighlight: (group) => { assert.equal(group, null) },
    computeSelectedTransform: () => assert.fail('no selected group has a readout'),
    setSelectedTransform: (value) => { cleared = value === null }
  })
  assert.equal(detached, true)
  assert.equal(cleared, true)
})
