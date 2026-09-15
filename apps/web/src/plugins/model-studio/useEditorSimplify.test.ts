import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { instanceFromStagedImport, seedEmptyEditorState } from './lib/editorModel'
import { collectSimplifyVolumeMeshes, restLinkedInstancesOnBed } from './useEditorSimplify'

const staged = {
  importId: 'mesh',
  name: 'Mesh',
  format: 'stl' as const,
  triangleCount: 1,
  bounds: { min: { x: 0, y: -1, z: 0 }, max: { x: 1, y: 0, z: 1 } },
  parts: []
}

test('helper volumes are simplification targets without a paint tag', () => {
  const group = new THREE.Group()
  const helper = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  helper.userData.isHelperVolume = true
  group.add(helper)

  assert.deepEqual(collectSimplifyVolumeMeshes(group), [helper])
})

test('bed rest uses the editor scale-then-rotate basis', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.rotation.set(Math.PI / 2, 0, 0)
  instance.scale.set(1, 2, 3)
  state.plates[0]!.instances.push(instance)
  const hostId = instance.source.kind === 'import' ? instance.source.replacedObjectId! : instance.objectId

  const rested = restLinkedInstancesOnBed(state, hostId, new Float32Array([
    0, -1, 0, 1, -1, 0, 0, 0, 0
  ]))

  assert.ok(Math.abs(rested.plates[0]!.instances[0]!.position.z - 3) < 1e-6)
})

test('bed rest preserves an exact basis and updates only its Z translation', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.exactMatrix = [1, 0, 0, 0, 1, 4, 0, 0, 1, 7, 8, 9]
  state.plates[0]!.instances.push(instance)
  const hostId = instance.source.kind === 'import' ? instance.source.replacedObjectId! : instance.objectId

  const rested = restLinkedInstancesOnBed(state, hostId, new Float32Array([
    0, -1, 0, 1, -1, 0, 0, 0, 0
  ]))
  const result = rested.plates[0]!.instances[0]!

  assert.deepEqual(result.exactMatrix?.slice(0, 11), instance.exactMatrix.slice(0, 11))
  assert.equal(result.exactMatrix?.[11], 4)
  assert.equal(result.position.z, 4)
})
