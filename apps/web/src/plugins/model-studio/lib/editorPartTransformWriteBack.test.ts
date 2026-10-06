import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import {
  addedPartHostId,
  buildSceneEdit,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorState
} from './editorModel'
import { writeBackEditorPartTransform } from './editorPartTransformWriteBack'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }

test('added-volume drag writes its local transform and reseats surface text', () => {
  const state = seedEmptyEditorState()
  const part = {
    key: 'text-part',
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1)
  }
  state.addedParts = { 1: [part] } as unknown as EditorState['addedParts']
  const mesh = new THREE.Group()
  mesh.userData.addedPartKey = part.key
  mesh.position.set(4, 5, 6)
  mesh.rotation.set(0, 0, Math.PI / 2)
  mesh.scale.set(2, 3, 4)
  let reseated = 0

  writeBackEditorPartTransform(mesh, {
    state,
    selectedPart: null,
    activePlate: null,
    groupByKey: new Map(),
    reseatDraggedText: () => { reseated += 1 }
  })

  assert.deepEqual(part.position.toArray(), [4, 5, 6])
  assert.deepEqual(part.scale.toArray(), [2, 3, 4])
  assert.equal(part.rotation.z, Math.PI / 2)
  assert.equal(reseated, 1)
})

test('baked-part drag updates linked copies by part ordinal and mirrors their live groups', () => {
  const staged: StagedImport = {
    importId: 'solid', name: 'Solid', format: 'stl', triangleCount: 2, bounds,
    parts: [
      { name: 'Body', triangleCount: 1, bounds, subtype: null },
      { name: 'Detail', triangleCount: 1, bounds, subtype: null }
    ]
  }
  const state = seedEmptyEditorState()
  const first = instanceFromStagedImport(staged)
  const linked = { ...first, key: 'linked', parts: first.parts.map((part) => ({ ...part })) }
  const other = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(first, linked, other)
  const ownerId = addedPartHostId(first)!

  const dragged = new THREE.Group()
  dragged.userData.partRef = { componentObjectId: 99, partIndex: 1 }
  dragged.position.set(4, 0, 0)
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  mesh.position.set(2, 0, 0)
  dragged.add(mesh)
  const firstRoot = new THREE.Group()
  firstRoot.add(dragged)

  const linkedPart = new THREE.Group()
  linkedPart.userData.partRef = { componentObjectId: 99, partIndex: 1 }
  const otherOrdinal = new THREE.Group()
  otherOrdinal.userData.partRef = { componentObjectId: 99, partIndex: 0 }
  const linkedRoot = new THREE.Group()
  linkedRoot.add(linkedPart, otherOrdinal)
  const groups = new Map([[first.key, firstRoot], [linked.key, linkedRoot]])

  writeBackEditorPartTransform(dragged, {
    state,
    selectedPart: { objectId: ownerId, member: { kind: 'baked', partIndex: 1 } },
    activePlate: state.plates[0]!,
    groupByKey: groups,
    reseatDraggedText: null
  })

  const matrix = state.partTransforms?.[`${ownerId}:1`]
  assert.ok(matrix)
  assert.deepEqual(first.parts[1]!.transform, matrix)
  assert.deepEqual(linked.parts[1]!.transform, matrix)
  assert.notDeepEqual(other.parts[1]!.transform, matrix)
  assert.equal(linkedPart.position.x, 4)
  assert.equal(otherOrdinal.position.x, 0, 'sharing a mesh ID does not move another ordinal')
  assert.equal(buildSceneEdit(state).importPartTransforms?.[0]?.partIndex, 1)
})
