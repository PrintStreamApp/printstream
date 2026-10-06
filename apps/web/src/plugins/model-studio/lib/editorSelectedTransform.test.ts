import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { computeEditorSelectedTransform } from './editorSelectedTransform'

test('object readout uses its rotor and displays degrees and percent', () => {
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.userData.rotor = rotor
  group.position.set(12, 3, 4)
  group.scale.set(1.5, 0.5, 2)
  rotor.rotation.z = Math.PI / 2

  assert.deepEqual(computeEditorSelectedTransform(group), {
    position: { x: 12, y: 3, z: 4 },
    rotationDeg: { x: 0, y: 0, z: 90 },
    scalePct: { x: 150, y: 50, z: 200 }
  })
})

test('added-part readout uses local placement', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
  mesh.userData.addedPartKey = 'added-1'
  mesh.position.set(2, 5, 7)
  mesh.rotation.x = Math.PI / 2

  assert.deepEqual(computeEditorSelectedTransform(mesh), {
    position: { x: 2, y: 5, z: 7 },
    rotationDeg: { x: 90, y: 0, z: 0 },
    scalePct: { x: 100, y: 100, z: 100 }
  })
})

test('baked and imported parts compose drag and baked child matrices', () => {
  for (const identityTag of ['partRef', 'importPartRef']) {
    const group = new THREE.Group()
    group.userData[identityTag] = { componentObjectId: 3, partIndex: 1 }
    group.position.x = 4
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    mesh.position.x = 3
    group.add(mesh)
    const readout = computeEditorSelectedTransform(group)
    assert.deepEqual(readout?.position, { x: 7, y: 0, z: 0 })
    assert.deepEqual(readout?.scalePct, { x: 100, y: 100, z: 100 })
    assert.equal(Math.abs(readout?.rotationDeg.x ?? NaN), 0)
    assert.equal(Math.abs(readout?.rotationDeg.y ?? NaN), 0)
    assert.equal(Math.abs(readout?.rotationDeg.z ?? NaN), 0)
    group.remove(mesh)
    assert.equal(computeEditorSelectedTransform(group), null)
  }
})
