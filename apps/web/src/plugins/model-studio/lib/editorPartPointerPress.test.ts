import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { ADDED_PART_MESH_NAME, type GizmoMode } from '../editorGeometry'
import { handleEditorPartPointerPress } from './editorPartPointerPress'
import type { EditorInstance } from './editorModel'
import type { PartRef } from './selectionModel'

function fixture(mode: GizmoMode, kind: 'added' | 'baked' | 'body') {
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.userData.rotor = rotor
  group.add(rotor)
  const partGroup = new THREE.Group()
  if (kind === 'baked') partGroup.userData.partRef = { componentObjectId: 15, partIndex: 1 }
  rotor.add(partGroup)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  if (kind === 'added') {
    mesh.name = ADDED_PART_MESH_NAME
    mesh.userData.addedPartKey = 'part-a'
  }
  partGroup.add(mesh)
  group.updateMatrixWorld(true)

  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  const orbit = { enabled: true }
  const calls: string[] = []
  const selected: Array<PartRef | null> = []
  const instance = {
    key: 'object-a', source: { kind: 'object' }, objectId: 7,
    parts: [{}, {}]
  } as EditorInstance
  const options = {
    group,
    instanceKey: instance.key,
    event: { pointerId: 4 } as PointerEvent,
    mode,
    raycaster,
    bedPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    dragPoint: new THREE.Vector3(999, 999, 999),
    canvas: { setPointerCapture: () => { calls.push('capture') } },
    orbit,
    findInstance: () => instance,
    extraSelectionCount: 0,
    selectedPart: null as PartRef | null,
    selectPart: (part: PartRef | null) => { selected.push(part) },
    beginBakedPart: (part: PartRef) => { selected.push(part); calls.push('defer') },
    beginAddedPartDrag: (picked: THREE.Object3D, pickedRotor: THREE.Object3D, point: THREE.Vector3) => {
      assert.equal(picked, mesh)
      assert.equal(pickedRotor, rotor)
      assert.deepEqual(point.toArray(), [0, 0, 0])
      calls.push('drag')
    }
  }
  return { calls, group, mesh, options, orbit, selected }
}

test('an added volume owns its press but only Move starts direct dragging', () => {
  const resting = fixture('select', 'added')
  assert.equal(handleEditorPartPointerPress(resting.options), true)
  assert.deepEqual(resting.selected, [{ objectId: 7, member: { kind: 'added', key: 'part-a' } }])
  assert.deepEqual(resting.calls, [])

  const moving = fixture('translate', 'added')
  assert.equal(handleEditorPartPointerPress(moving.options), true)
  assert.deepEqual(moving.calls, ['drag', 'capture'])
  assert.equal(moving.orbit.enabled, false)
})

test('a body press exits added-volume selection but leaves baked selection intact', () => {
  const body = fixture('select', 'body')
  body.options.selectedPart = { objectId: 7, member: { kind: 'added', key: 'part-a' } }
  assert.equal(handleEditorPartPointerPress(body.options), false)
  assert.deepEqual(body.selected, [null])

  const baked = fixture('select', 'body')
  baked.options.selectedPart = { objectId: 7, member: { kind: 'baked', partIndex: 0 } }
  assert.equal(handleEditorPartPointerPress(baked.options), false)
  assert.deepEqual(baked.selected, [])
})

test('a baked volume defers selection to release only for one selected object', () => {
  const baked = fixture('select', 'baked')
  assert.equal(handleEditorPartPointerPress(baked.options), false)
  assert.deepEqual(baked.selected, [{ objectId: 7, member: { kind: 'baked', partIndex: 1 } }])
  assert.deepEqual(baked.calls, ['defer'])

  const multi = fixture('select', 'baked')
  multi.options.extraSelectionCount = 1
  assert.equal(handleEditorPartPointerPress(multi.options), false)
  assert.deepEqual(multi.selected, [])
})
