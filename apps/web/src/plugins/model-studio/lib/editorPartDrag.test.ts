import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorPartDrag } from './editorPartDrag'

test('selecting an added part without moving it creates no history entry', () => {
  const rotor = new THREE.Group()
  const mesh = new THREE.Object3D()
  rotor.add(mesh)
  let history = 0
  const drag = createEditorPartDrag({
    recordHistory: () => { history += 1 },
    writeBackPartMesh: () => undefined,
    reseatPivot: () => undefined
  })

  drag.begin(mesh, rotor, new THREE.Vector3(5, 6, 0))
  assert.equal(drag.active, true)
  assert.equal(drag.finish(), mesh)
  assert.equal(drag.active, false)
  assert.equal(history, 0)
})

test('a part drag converts world motion through its rotated rotor and preserves height', () => {
  const rotor = new THREE.Group()
  rotor.position.set(20, 30, 0)
  rotor.rotation.z = Math.PI / 2
  const mesh = new THREE.Object3D()
  mesh.position.set(3, 4, 7)
  rotor.add(mesh)
  rotor.updateMatrixWorld(true)
  let history = 0
  const writes: THREE.Object3D[] = []
  let reseated = 0
  const drag = createEditorPartDrag({
    recordHistory: () => { history += 1 },
    writeBackPartMesh: (part) => { writes.push(part) },
    reseatPivot: () => { reseated += 1 }
  })

  const press = new THREE.Vector3(15, 31, 0)
  drag.begin(mesh, rotor, press)
  drag.move(new THREE.Vector3(18, 34, 0))
  drag.move(new THREE.Vector3(19, 35, 0))

  assert.ok(Math.abs(mesh.position.x - 7) < 0.000001)
  assert.ok(Math.abs(mesh.position.y) < 0.000001)
  assert.equal(mesh.position.z, 7)
  assert.equal(history, 1)
  assert.deepEqual(writes, [mesh, mesh])
  assert.equal(reseated, 2)
  assert.equal(drag.finish(), mesh)
  assert.equal(drag.move(new THREE.Vector3(20, 36, 0)), false)
})
