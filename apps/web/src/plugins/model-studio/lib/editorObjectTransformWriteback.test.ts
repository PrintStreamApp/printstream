import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { seedEmptyEditorState, type EditorInstance } from './editorModel'
import { prepareEditorObjectTransform, writeBackEditorObjectTransform } from './editorObjectTransformWriteback'

function makeInstance(): EditorInstance {
  return {
    key: 'foreign-object',
    source: { kind: 'object' },
    objectId: 7,
    instanceId: 0,
    name: 'Foreign object',
    position: new THREE.Vector3(10, 20, 30),
    rotation: new THREE.Euler(0.1, 0.2, 0.3),
    scale: new THREE.Vector3(2, 3, 4),
    exactMatrix: [1, 0.25, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    filamentId: 1,
    printable: true,
    parts: [],
    color: null
  }
}

test('first transform converts a foreign exact matrix before writing the live pose back', () => {
  const state = seedEmptyEditorState()
  const instance = makeInstance()
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.add(rotor)
  group.userData.instanceKey = instance.key
  group.userData.rotor = rotor
  group.matrixAutoUpdate = false
  group.position.set(99, 99, 99)

  prepareEditorObjectTransform(state, group)

  assert.equal(instance.exactMatrix, undefined)
  assert.equal(group.matrixAutoUpdate, true)
  assert.deepEqual(group.position.toArray(), [10, 20, 30])
  assert.deepEqual(group.scale.toArray(), [2, 3, 4])
  assert.deepEqual(rotor.rotation.toArray(), instance.rotation.toArray())

  group.position.set(11, 22, 33)
  group.scale.set(1, 1.5, 2)
  rotor.rotation.set(0.4, 0.5, 0.6)
  writeBackEditorObjectTransform(state, group)

  assert.deepEqual(instance.position.toArray(), [11, 22, 33])
  assert.deepEqual(instance.scale.toArray(), [1, 1.5, 2])
  assert.deepEqual(instance.rotation.toArray(), rotor.rotation.toArray())
})

test('a group without a matching instance leaves the editor model untouched', () => {
  const state = seedEmptyEditorState()
  const instance = makeInstance()
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  group.userData.instanceKey = 'removed-object'

  prepareEditorObjectTransform(state, group)
  writeBackEditorObjectTransform(state, group)

  assert.ok(instance.exactMatrix)
  assert.deepEqual(instance.position.toArray(), [10, 20, 30])
})
