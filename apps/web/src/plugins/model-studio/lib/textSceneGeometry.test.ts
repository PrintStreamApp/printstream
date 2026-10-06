import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { nearestSurfaceAt, worldTrianglesOf } from './textSceneGeometry'

test('text projection reads only the selected host meshes in world coordinates', () => {
  const selected = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
  selected.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  selected.position.x = 5
  const excluded = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshBasicMaterial())

  assert.deepEqual([...worldTrianglesOf([selected])], [5, 0, 0, 6, 0, 0, 5, 1, 0])
  assert.equal(worldTrianglesOf([selected]).length, 9)
  assert.equal(worldTrianglesOf([excluded]).length > 9, true)
})

test('dragged text finds the nearest host face and ignores an empty host', () => {
  const host = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
  host.updateWorldMatrix(true, false)
  const box = new THREE.Box3().setFromObject(host)

  const seat = nearestSurfaceAt(new THREE.Vector3(3, 0, 0), [host], box)
  assert.ok(seat)
  assert.equal(Math.abs(seat.point.x - 1) < 1e-6, true)
  assert.equal(nearestSurfaceAt(new THREE.Vector3(3, 0, 0), [], box), null)
})
