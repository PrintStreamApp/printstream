import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { BRIM_EAR_MARKER_NAME } from '../editorGeometry'
import { pickBrimEarEdit, pickEditorInstanceGroup } from './editorObjectPicking'

function downRay(): THREE.Raycaster {
  const raycaster = new THREE.Raycaster()
  raycaster.set(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
  return raycaster
}

test('object picking resolves a nested mesh to its live instance group', () => {
  const group = new THREE.Group()
  group.userData.instanceKey = 'object-1'
  const rotor = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  rotor.add(mesh)
  group.add(rotor)
  group.updateMatrixWorld(true)
  const groups = new Map([['object-1', group]])

  assert.equal(pickEditorInstanceGroup(downRay(), groups), group)
  groups.clear()
  assert.equal(pickEditorInstanceGroup(downRay(), groups), null)

  mesh.geometry.dispose()
})

test('brim-ear picking removes a marker near the surface and adds on a farther hit', () => {
  const group = new THREE.Group()
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.25))
  marker.name = BRIM_EAR_MARKER_NAME
  marker.userData.brimEarIndex = 3
  marker.position.z = 1
  group.add(marker)
  group.updateMatrixWorld(true)
  const raycaster = downRay()
  const surface = { point: new THREE.Vector3(0, 0, 0) }

  assert.deepEqual(pickBrimEarEdit(raycaster, group, surface), { kind: 'remove', index: 3 })
  marker.position.z = -2
  group.updateMatrixWorld(true)
  assert.deepEqual(pickBrimEarEdit(raycaster, group, surface), {
    kind: 'add', group, worldPoint: surface.point
  })

  marker.geometry.dispose()
})

test('brim-ear picking ignores an unindexed marker and a pointer miss', () => {
  const group = new THREE.Group()
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.25))
  marker.name = BRIM_EAR_MARKER_NAME
  group.add(marker)
  group.updateMatrixWorld(true)

  assert.equal(pickBrimEarEdit(downRay(), group, null), null)
  const surface = { point: new THREE.Vector3(0, 0, 0) }
  assert.deepEqual(pickBrimEarEdit(downRay(), group, surface), {
    kind: 'add', group, worldPoint: surface.point
  })

  marker.geometry.dispose()
})
