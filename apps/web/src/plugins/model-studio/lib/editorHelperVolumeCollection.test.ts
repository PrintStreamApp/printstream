import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { collectEditorHelperVolumes } from './editorHelperVolumeCollection'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorAddedPart
} from './editorModel'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'solid', name: 'Solid', format: 'stl', triangleCount: 3, bounds,
  parts: [
    { name: 'Body', triangleCount: 1, bounds, subtype: null },
    { name: 'Blocker', triangleCount: 1, bounds, subtype: 'support_blocker' },
    { name: 'Enforcer', triangleCount: 1, bounds, subtype: 'support_enforcer' }
  ]
}

/** Match the scene's helper tagging at both group and mesh levels. */
function helperMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
  mesh.userData.isHelperVolume = true
  return mesh
}

test('baked helper resolves its stable part ordinal after another part is removed', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.parts = instance.parts.filter((part) => part.partIndex !== 1)
  const group = new THREE.Group()
  const baked = new THREE.Group()
  baked.userData.isHelperVolume = true
  baked.userData.partRef = { componentObjectId: 9, partIndex: 2 }
  baked.add(helperMesh())
  group.add(baked)

  const volumes = collectEditorHelperVolumes(state, instance, group)
  assert.equal(volumes.length, 1, 'the tagged child mesh must not create a duplicate')
  assert.equal(volumes[0]?.subtype, 'support_enforcer')
  assert.equal(volumes[0]?.name, 'Enforcer')
  assert.equal(volumes[0]?.soup.length, 108)
})

test('session-added helper retains its metadata and world placement', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  const hostId = addedPartHostId(instance)!
  const added: EditorAddedPart = {
    key: 'added', importId: 'helper', subtype: 'modifier_part', name: 'Density zone', filamentId: 4,
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array()
  }
  state.addedParts = { [hostId]: [added] }
  const group = new THREE.Group()
  const mesh = helperMesh()
  mesh.userData.addedPartKey = added.key
  mesh.position.x = 7
  group.add(mesh)

  const volumes = collectEditorHelperVolumes(state, instance, group)
  assert.equal(volumes.length, 1)
  assert.equal(volumes[0]?.subtype, 'modifier_part')
  assert.equal(volumes[0]?.name, 'Density zone')
  assert.equal(volumes[0]?.filamentId, 4)
  const xs = volumes[0]!.soup.filter((_, index) => index % 3 === 0)
  assert.ok(Math.min(...xs) > 6, 'the soup must be in world space')
})
