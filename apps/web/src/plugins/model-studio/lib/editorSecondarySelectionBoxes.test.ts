import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { ADDED_PART_MESH_NAME } from '../editorGeometry'
import type { EditorInstance } from './editorModel'
import { createEditorSecondarySelectionBoxes, type SecondarySelectionFrame } from './editorSecondarySelectionBoxes'
import { SELECTION_OWNER_LAYER } from './selectionBox'

function mesh(x = 0) {
  const result = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial())
  result.position.x = x
  return result
}

function instance(key: string, objectId: number, x: number) {
  const group = new THREE.Group()
  group.position.x = x
  const rotor = new THREE.Group()
  group.userData.rotor = rotor
  group.add(rotor)

  const body = mesh()
  rotor.add(body)
  const baked = new THREE.Group()
  baked.userData.partRef = { componentObjectId: 30, partIndex: 1 }
  baked.add(mesh(5))
  rotor.add(baked)
  const added = new THREE.Group()
  added.userData.addedPartKey = 'added-1'
  const addedMesh = mesh(40)
  addedMesh.name = ADDED_PART_MESH_NAME
  added.add(addedMesh)
  rotor.add(added)

  const record = { key, objectId, source: { kind: 'object' } } as EditorInstance
  return { group, body, baked, added, addedMesh, record }
}

function boxes(scene: THREE.Scene): THREE.Box3Helper[] {
  return scene.children.filter((child): child is THREE.Box3Helper => child instanceof THREE.Box3Helper)
}

test('extra selections follow live groups and release outline resources on clear and teardown', () => {
  const scene = new THREE.Scene()
  const first = instance('one', 10, 0)
  const second = instance('two', 20, 20)
  const groups = new Map([['one', first.group], ['two', second.group]])
  const controller = createEditorSecondarySelectionBoxes(scene)
  const frame: SecondarySelectionFrame = {
    extraKeys: ['one'], groups, partSelection: null, gizmoPart: null,
    instances: [first.record, second.record], primaryOwner: null
  }

  controller.sync(frame)
  assert.equal(controller.active, true)
  assert.equal(boxes(scene).length, 1)
  assert.equal(first.body.layers.isEnabled(SELECTION_OWNER_LAYER), true)
  const original = boxes(scene)[0]
  assert.ok(original)
  let disposed = 0
  original.geometry.addEventListener('dispose', () => { disposed += 1 })
  ;(original.material as THREE.Material).addEventListener('dispose', () => { disposed += 1 })

  frame.extraKeys = ['two']
  controller.sync(frame)
  assert.equal(disposed, 2)
  assert.equal(boxes(scene).length, 1)
  assert.equal(first.body.layers.isEnabled(SELECTION_OWNER_LAYER), false)
  assert.equal(second.body.layers.isEnabled(SELECTION_OWNER_LAYER), true)

  // A plate rebuild can replace a group without changing its instance key.
  groups.set('two', first.group)
  controller.sync(frame)
  assert.equal(first.body.layers.isEnabled(SELECTION_OWNER_LAYER), true)
  assert.equal(second.body.layers.isEnabled(SELECTION_OWNER_LAYER), false)

  controller.dispose()
  assert.equal(controller.active, false)
  assert.equal(boxes(scene).length, 0)
  assert.equal(first.body.layers.isEnabled(SELECTION_OWNER_LAYER), false)
  for (const part of [first, second]) {
    part.group.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        (node as THREE.Mesh).geometry.dispose()
        ;((node as THREE.Mesh).material as THREE.Material).dispose()
      }
    })
  }
})

test('part selection outlines each linked copy and distinguishes baked, added, and body members', () => {
  const scene = new THREE.Scene()
  const first = instance('one', 10, 0)
  const second = instance('two', 10, 100)
  const groups = new Map([['one', first.group], ['two', second.group]])
  const controller = createEditorSecondarySelectionBoxes(scene)
  const frame: SecondarySelectionFrame = {
    extraKeys: [], groups, partSelection: { objectId: 10, members: [{ kind: 'baked', partIndex: 1 }] },
    gizmoPart: null, instances: [first.record, second.record], primaryOwner: null
  }

  controller.sync(frame)
  assert.equal(boxes(scene).length, 2)
  assert.deepEqual(new Set(boxes(scene).map((box) => box.userData.selectionOwner)), new Set([first.baked, second.baked]))
  const firstBox = boxes(scene)[0]
  assert.ok(firstBox)
  assert.equal((firstBox.material as THREE.LineBasicMaterial).depthTest, false)

  frame.partSelection = { objectId: 10, members: [{ kind: 'added', key: 'added-1' }] }
  controller.sync(frame)
  assert.deepEqual(new Set(boxes(scene).map((box) => box.userData.selectionOwner)), new Set([first.added, second.added]))

  frame.partSelection = { objectId: 10, members: [{ kind: 'body' }] }
  controller.sync(frame)
  assert.equal(boxes(scene).length, 2)
  assert.ok(boxes(scene).every((box) => box.box.max.x < 110))
  assert.deepEqual(new Set(boxes(scene).map((box) => box.userData.selectionOwner)), new Set([first.group, second.group]))

  frame.partSelection = null
  controller.sync(frame)
  assert.equal(boxes(scene).length, 0)
  assert.equal(controller.active, false)
  controller.dispose()
  for (const part of [first, second]) {
    part.group.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) {
        (node as THREE.Mesh).geometry.dispose()
        ;((node as THREE.Mesh).material as THREE.Material).dispose()
      }
    })
  }
})
