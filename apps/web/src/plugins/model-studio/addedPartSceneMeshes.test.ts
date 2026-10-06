import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { EditorAddedPart, EditorInstance, EditorState } from './lib/editorModel'
import type { LayerBandUniforms } from './editorGeometry'
import { replaceAddedPartSceneMeshes } from './addedPartSceneMeshes'

function addedPart(key: string, subtype: EditorAddedPart['subtype']): EditorAddedPart {
  return {
    key,
    importId: `import-${key}`,
    subtype,
    name: key,
    position: new THREE.Vector3(1, 2, 3),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    soup: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  }
}

test('added-part rebuild disposes old meshes and distinguishes printed parts from helpers', () => {
  const group = new THREE.Group()
  const rotor = new THREE.Group()
  group.add(rotor)
  group.userData.rotor = rotor
  const old = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial())
  old.name = 'addedPartVolume'
  rotor.add(old)
  let disposed = 0
  old.geometry.addEventListener('dispose', () => { disposed += 1 })

  const instance = { key: 'instance-1', source: { kind: 'object' }, objectId: 7, filamentId: 1, color: '#123456' } as EditorInstance
  const state = { plates: [], addedParts: { 7: [addedPart('printed', 'normal_part'), addedPart('aid', 'support_blocker')] } } as EditorState
  const seeded: string[] = []
  const options = {
    group,
    instance,
    state,
    resolveColorFilamentId: (id: number | null) => id,
    filamentColors: { 1: '#ff0000' },
    layerBandUniforms: {} as LayerBandUniforms,
    seedPaintOverlays: (_mesh: THREE.Mesh, key: string) => { seeded.push(key) }
  }

  replaceAddedPartSceneMeshes(options)

  assert.equal(disposed, 1)
  assert.equal(rotor.children.length, 2)
  const printed = rotor.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  const aid = rotor.children[1] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  assert.equal(printed.userData.isHelperVolume, undefined)
  assert.deepEqual(printed.userData.supportPaintPart, { addedPartImportId: 'import-printed' })
  assert.equal(printed.material.color.getHexString(), 'ff0000')
  assert.equal(aid.userData.isHelperVolume, true)
  assert.equal(aid.material.transparent, true)
  assert.equal(aid.userData.supportPaintPart, undefined)
  assert.equal(seeded.length, 1)

  printed.geometry.addEventListener('dispose', () => { disposed += 1 })
  aid.geometry.addEventListener('dispose', () => { disposed += 1 })
  replaceAddedPartSceneMeshes({ ...options, state: { plates: [], addedParts: {} } as EditorState })

  assert.equal(disposed, 3)
  assert.equal(rotor.children.length, 0)
})
