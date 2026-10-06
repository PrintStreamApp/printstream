import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'
import { syncEditorTransformScene } from './editorTransformSceneSync'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
const staged: StagedImport = {
  importId: 'solid', name: 'Solid', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Body', triangleCount: 12, bounds, subtype: null }]
}

test('transform sync updates mounted position, scale, and the inner rotor', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.position.set(12, 23, 34)
  instance.scale.set(2, 3, 4)
  instance.rotation.set(0.1, 0.2, 0.3)
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.userData.rotor = rotor
  group.add(rotor)

  assert.equal(syncEditorTransformScene(state, new Map([[instance.key, group]])), true)
  assert.deepEqual(group.position.toArray(), [12, 23, 34])
  assert.deepEqual(group.scale.toArray(), [2, 3, 4])
  assert.deepEqual(rotor.rotation.toArray().slice(0, 3), [0.1, 0.2, 0.3])
})

test('an exact-matrix group requests rebuild before any mounted group changes', () => {
  const state = seedEmptyEditorState()
  const first = instanceFromStagedImport(staged)
  const exact = instanceFromStagedImport(staged)
  first.position.x = 12
  state.plates[0]!.instances.push(first, exact)
  const firstGroup = new THREE.Group()
  const exactGroup = new THREE.Group()
  exactGroup.matrixAutoUpdate = false

  assert.equal(syncEditorTransformScene(state, new Map([
    [first.key, firstGroup],
    [exact.key, exactGroup]
  ])), false)
  assert.equal(firstGroup.position.x, 0)
})
