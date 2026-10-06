import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'
import { configureEditorTransformGizmo } from './editorTransformGizmo'

function handle(name: string, tag?: string): THREE.Object3D {
  const object = new THREE.Object3D()
  object.name = name
  Object.assign(object, { tag })
  return object
}

test('editor gizmo removes out-of-bed handles from every layer and restores its update on release', () => {
  const modes = () => ({ translate: new THREE.Group(), scale: new THREE.Group() })
  const gizmo = {
    gizmo: modes(),
    picker: modes(),
    helper: modes(),
    updateMatrixWorld(_force?: boolean) { this.gizmo.translate.position.x += 1 }
  }
  const originalUpdate = gizmo.updateMatrixWorld
  let space: string | null = null

  for (const layer of [gizmo.gizmo, gizmo.picker, gizmo.helper]) {
    for (const name of ['XYZ', 'Z', 'YZ', 'XZ', 'X', 'Y', 'XY']) {
      layer.translate.add(handle(name))
    }
    for (const name of ['XYZ', 'X', 'Y']) layer.scale.add(handle(name))
  }

  const forward = handle('X', 'fwd')
  forward.scale.x = -1
  forward.visible = false
  const backward = handle('X', 'bwd')
  backward.visible = true
  const edgeOn = handle('Y', 'fwd')
  edgeOn.scale.x = -1e-10
  edgeOn.visible = false
  gizmo.gizmo.translate.add(forward, backward, edgeOn)

  const transform = {
    gizmo,
    setSpace(next: string) { space = next }
  } as unknown as TransformControls
  const release = configureEditorTransformGizmo(transform)

  assert.equal(space, 'world')
  for (const layer of [gizmo.gizmo, gizmo.picker, gizmo.helper]) {
    assert.deepEqual(layer.translate.children.slice(0, 3).map((child) => child.name), ['X', 'Y', 'XY'])
    assert.deepEqual(layer.scale.children.map((child) => child.name), ['X', 'Y'])
  }

  gizmo.updateMatrixWorld(true)
  assert.equal(gizmo.gizmo.translate.position.x, 1)
  assert.equal(forward.scale.x, 1)
  assert.equal(forward.visible, true)
  assert.equal(backward.visible, false)
  assert.equal(edgeOn.scale.x, -1e-10)
  assert.equal(edgeOn.visible, false)

  release()
  assert.equal(gizmo.updateMatrixWorld, originalUpdate)
})

test('editor gizmo still sets world space when three-stdlib internals are unavailable', () => {
  let space: string | null = null
  const transform = { setSpace(next: string) { space = next } } as unknown as TransformControls
  const release = configureEditorTransformGizmo(transform)
  assert.equal(space, 'world')
  release()
})
