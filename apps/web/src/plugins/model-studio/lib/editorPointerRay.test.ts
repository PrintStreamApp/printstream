import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { aimEditorPointerRay } from './editorPointerRay'

test('editor pointer ray uses current canvas bounds for selection and drag hits', () => {
  let bounds = { left: 100, top: 50, width: 200, height: 100 }
  const canvas = { getBoundingClientRect: () => bounds } as HTMLCanvasElement
  const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const pointer = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()

  aimEditorPointerRay(canvas, camera, pointer, raycaster, { clientX: 200, clientY: 100 })
  assert.deepEqual(pointer.toArray(), [0, 0])
  assert.ok(raycaster.ray.direction.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-8)

  aimEditorPointerRay(canvas, camera, pointer, raycaster, { clientX: 100, clientY: 50 })
  assert.deepEqual(pointer.toArray(), [-1, 1])
  assert.ok(raycaster.ray.direction.x < 0)
  assert.ok(raycaster.ray.direction.y > 0)

  bounds = { left: 100, top: 50, width: 400, height: 200 }
  aimEditorPointerRay(canvas, camera, pointer, raycaster, { clientX: 200, clientY: 100 })
  assert.deepEqual(pointer.toArray(), [-0.5, 0.5])
})
