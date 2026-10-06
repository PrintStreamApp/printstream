import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import { createEditorPrimarySelectionBox } from './editorPrimarySelectionBox'

function selectionFixture() {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 2, 2), new THREE.MeshBasicMaterial())
  group.add(mesh)
  group.rotation.z = Math.PI / 4
  const selectionBox = createEditorPrimarySelectionBox(scene)
  selectionBox.set(group)
  const helper = scene.children[0] as THREE.Box3Helper
  return { scene, group, mesh, selectionBox, helper }
}

test('a new outline stays hidden until a settled precise fit and disposes on clear', () => {
  const { scene, group, mesh, selectionBox, helper } = selectionFixture()
  assert.equal(helper.visible, false)
  assert.equal(selectionBox.visibleOwner(), null)

  assert.equal(selectionBox.update({ interacting: false, dragJustEnded: false, changedOrientation: false }), true)
  assert.equal(helper.visible, false)
  assert.equal(selectionBox.update({ interacting: false, dragJustEnded: false, changedOrientation: false }), false)
  assert.equal(helper.visible, true)
  assert.equal(selectionBox.visibleOwner(), group)

  selectionBox.set(null)
  assert.equal(scene.children.length, 0)
  assert.equal(selectionBox.visibleOwner(), null)
  assert.equal(selectionBox.update({ interacting: false, dragJustEnded: false, changedOrientation: false }), false)
  mesh.geometry.dispose()
  mesh.material.dispose()
})

test('an active drag cancels a pending fit; a move drop re-arms it', () => {
  const { mesh, group, selectionBox, helper } = selectionFixture()
  group.position.x += 5
  assert.equal(selectionBox.update({ interacting: true, dragJustEnded: false, changedOrientation: false }), false)
  assert.equal(helper.visible, false)

  assert.equal(selectionBox.update({ interacting: false, dragJustEnded: true, changedOrientation: false }), true)
  assert.equal(helper.visible, false)
  assert.equal(selectionBox.update({ interacting: false, dragJustEnded: false, changedOrientation: false }), false)
  assert.equal(helper.visible, true)

  selectionBox.set(null)
  mesh.geometry.dispose()
  mesh.material.dispose()
})
