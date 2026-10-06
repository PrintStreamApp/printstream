import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { printableMeshBox, rotorOf } from '../editorGeometry'
import { placeObjectOnFace } from './editorPlaceOnFace'

test('placing an off-centre face keeps the footprint centred and rests printable geometry', () => {
  const group = new THREE.Group()
  group.position.set(30, 40, 8)
  const rotor = new THREE.Group()
  group.userData.rotor = rotor
  group.add(rotor)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 8, 2))
  mesh.position.set(6, 3, 1)
  rotor.add(mesh)
  group.updateMatrixWorld(true)
  const before = printableMeshBox(group)
  const beforeX = (before.min.x + before.max.x) / 2
  const beforeY = (before.min.y + before.max.y) / 2
  const calls: string[] = []

  const placed = placeObjectOnFace({
    group,
    hit: { object: mesh, face: { normal: new THREE.Vector3(1, 0, 0) } },
    recordHistory: () => { calls.push('history') },
    bakeExactMatrix: () => {
      calls.push('bake')
      // A shearing object's bake can change the hit mesh matrix. The clicked normal is pre-bake.
      mesh.matrixWorld.makeRotationZ(Math.PI / 2)
    },
    writeBackGroupTransform: () => { calls.push('write') }
  })

  const after = printableMeshBox(group)
  assert.equal(placed, true)
  assert.deepEqual(calls, ['history', 'bake', 'write'])
  assert.ok(Math.abs((after.min.x + after.max.x) / 2 - beforeX) < 0.00001)
  assert.ok(Math.abs((after.min.y + after.max.y) / 2 - beforeY) < 0.00001)
  assert.ok(Math.abs(after.min.z) < 0.00001)
  assert.ok(new THREE.Vector3(1, 0, 0).applyQuaternion(rotorOf(group).quaternion).distanceTo(new THREE.Vector3(0, 0, -1)) < 0.00001)
})

test('a hit without a face leaves history and the object untouched', () => {
  const group = new THREE.Group()
  group.position.set(5, 6, 7)
  let calls = 0
  assert.equal(placeObjectOnFace({
    group,
    hit: { object: group, face: null },
    recordHistory: () => { calls += 1 },
    bakeExactMatrix: () => { calls += 1 },
    writeBackGroupTransform: () => { calls += 1 }
  }), false)
  assert.equal(calls, 0)
  assert.deepEqual(group.position.toArray(), [5, 6, 7])
})
