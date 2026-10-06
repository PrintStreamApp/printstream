import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createEditorPaintPicker } from './editorPaintPicking'

test('paint picker follows the live selection and leaves the shared ray aimed at the hit', () => {
  const canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 })
  } as HTMLCanvasElement
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100)
  camera.position.set(0, 0, 20)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  const pointer = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()

  const selectedGroup = new THREE.Group()
  const printable = new THREE.Mesh(new THREE.PlaneGeometry(10, 10).toNonIndexed(), new THREE.MeshBasicMaterial())
  printable.userData.supportPaintPart = true
  selectedGroup.add(printable)
  const decoration = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial())
  selectedGroup.add(decoration)
  let selected: THREE.Group | null = selectedGroup
  const picker = createEditorPaintPicker({ canvas, camera, pointer, raycaster, getSelectedGroup: () => selected })

  assert.deepEqual(picker.targets(), [printable])
  const hit = picker.hitOnSelected({ clientX: 50, clientY: 50 } as PointerEvent)
  assert.ok(hit)
  assert.equal(hit.mesh, printable)
  assert.ok(hit.point.distanceTo(new THREE.Vector3(0, 0, 0)) < 0.001)
  assert.ok(hit.normal.z > 0.99)
  assert.ok(raycaster.ray.direction.z < -0.99, 'paint application reads this sample direction')

  selected = null
  assert.deepEqual(picker.targets(), [])
  assert.equal(picker.hitOnSelected({ clientX: 50, clientY: 50 } as PointerEvent), null)
})
