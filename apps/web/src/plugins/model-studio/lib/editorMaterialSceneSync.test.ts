import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { syncEditorMaterialScene } from './editorMaterialSceneSync'
import type { EditorInstance, EditorState } from './editorModel'

function colouredMesh(filamentId: number | null): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial())
  mesh.userData.recolor = { filamentId }
  mesh.userData['paintOverlayCache:color'] = { stale: true }
  return mesh
}

test('material sync keeps part, added-volume, and helper colours independent', () => {
  const instance = {
    key: 'object',
    filamentId: 1,
    parts: [{ partIndex: 0, filamentId: 2, subtype: 'normal_part' }]
  } as EditorInstance
  const state = {
    plates: [{ instances: [instance] }],
    addedParts: {
      1: [
        { key: 'logo', filamentId: 3, subtype: 'normal_part' },
        { key: 'blocker', filamentId: null, subtype: 'support_blocker' }
      ]
    }
  } as unknown as EditorState
  const group = new THREE.Group()

  const bakedPart = new THREE.Group()
  bakedPart.userData.partRef = { partIndex: 0 }
  const bakedMesh = colouredMesh(1)
  bakedPart.add(bakedMesh)
  group.add(bakedPart)

  const addedPart = new THREE.Group()
  addedPart.userData.addedPartKey = 'logo'
  const addedMesh = colouredMesh(1)
  addedPart.add(addedMesh)
  group.add(addedPart)

  const helperPart = new THREE.Group()
  helperPart.userData.addedPartKey = 'blocker'
  const helperMesh = colouredMesh(null)
  const helperMaterial = helperMesh.material as THREE.MeshStandardMaterial
  helperMaterial.color.set('#808080')
  helperPart.add(helperMesh)
  group.add(helperPart)

  syncEditorMaterialScene(state, new Map([['object', group]]), (id) => id, {
    1: '#ff0000', 2: '#00ff00', 3: '#0000ff'
  })

  assert.equal((bakedMesh.material as THREE.MeshStandardMaterial).color.getHexString(), '00ff00')
  assert.equal(bakedMesh.userData.recolor.filamentId, 2)
  assert.equal(bakedMesh.userData['paintOverlayCache:color'], undefined)
  assert.equal((addedMesh.material as THREE.MeshStandardMaterial).color.getHexString(), '0000ff')
  assert.equal(addedMesh.userData.recolor.filamentId, 3)
  assert.equal((helperMesh.material as THREE.MeshStandardMaterial).color.getHexString(), '808080')
  assert.equal(helperMesh.userData['paintOverlayCache:color'].stale, true)
})

test('a part without its own material inherits the host material', () => {
  const instance = {
    key: 'object', filamentId: 1,
    parts: [{ partIndex: 0, filamentId: null, subtype: 'normal_part' }]
  } as EditorInstance
  const state = { plates: [{ instances: [instance] }] } as EditorState
  const group = new THREE.Group()
  const part = new THREE.Group()
  part.userData.importPartRef = { partIndex: 0 }
  const mesh = colouredMesh(null)
  part.add(mesh)
  group.add(part)

  syncEditorMaterialScene(state, new Map([['object', group]]), (id) => id, { 1: '#abcdef' })

  assert.equal((mesh.material as THREE.MeshStandardMaterial).color.getHexString(), 'abcdef')
  assert.equal(mesh.userData.recolor.filamentId, 1)
})
