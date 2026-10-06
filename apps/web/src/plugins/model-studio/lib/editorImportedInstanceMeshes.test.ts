import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { partSlotKey, type EditorInstance, type EditorState } from './editorModel'
import type { LayerBandUniforms } from '../editorGeometry'
import { buildImportedInstanceMeshes } from './editorImportedInstanceMeshes'

function geometry(): THREE.BufferGeometry {
  const mesh = new THREE.BufferGeometry()
  mesh.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  return mesh
}

function importedInstance(parts: EditorInstance['parts'] = []): EditorInstance {
  return {
    key: 'imported', source: { kind: 'import', importId: 'staged', meshUrl: '/mesh', replacedObjectId: -7 },
    objectId: 0, instanceId: 0, name: 'Import', position: new THREE.Vector3(),
    rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1), filamentId: 1,
    printable: true, color: '#123456', parts
  }
}

function layerBands(): LayerBandUniforms {
  return {
    uFcCount: { value: 0 }, uFcHeights: { value: [] }, uFcColors: { value: [] },
    uPauseCount: { value: 0 }, uPauseHeights: { value: [] }
  }
}

test('a surviving import solid keeps its source index after another solid is removed', async () => {
  const instance = importedInstance([{
    entryPath: '', componentObjectId: 9, partIndex: 2, transform: [], filamentId: 3,
    name: 'Survivor', color: null, subtype: 'normal_part'
  }])
  const state = { removedParts: { '-7': [0] } } as unknown as EditorState
  const rotor = new THREE.Group()
  const reads: Array<[string, number | undefined]> = []
  const paints: string[] = []
  await buildImportedInstanceMeshes({
    instance,
    rotor,
    placement: new THREE.Matrix4(),
    meshColor: '#123456',
    meshFilamentId: 1,
    getState: () => state,
    resolveColorFilamentId: (id) => id,
    getFilamentColors: () => ({ 3: '#abcdef' }),
    getLayerBandUniforms: layerBands,
    fetchImportGeometry: async (id, partIndex) => { reads.push([id, partIndex]); return geometry() },
    seedPaintOverlays: (_mesh, key) => { paints.push(key) }
  })

  assert.deepEqual(reads, [['staged', 2]])
  assert.equal(rotor.children.length, 1)
  const group = rotor.children[0] as THREE.Group
  const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  assert.deepEqual(group.userData.importPartRef, { componentObjectId: 9, partIndex: 2 })
  assert.deepEqual(mesh.userData.supportPaintPart, { objectId: -7, componentObjectId: 9 })
  assert.equal(mesh.material.color.getHexString(), 'abcdef')
  assert.equal(paints.length, 1)
})

test('a helper body has no paint target, and a removed body builds no mesh', async () => {
  const instance = importedInstance()
  let state = {} as EditorState
  const rotor = new THREE.Group()
  let reads = 0
  const options = {
    instance,
    rotor,
    placement: new THREE.Matrix4(),
    meshColor: '#123456',
    meshFilamentId: 1,
    getState: () => state,
    resolveColorFilamentId: (id: number | null) => id,
    getFilamentColors: () => null,
    getLayerBandUniforms: layerBands,
    fetchImportGeometry: async () => {
      reads += 1
      state = { partTypeChanges: { [partSlotKey(-7, 0)]: 'support_blocker' } } as EditorState
      return geometry()
    },
    seedPaintOverlays: () => { throw new Error('helper body must not seed paint') }
  }
  await buildImportedInstanceMeshes(options)
  assert.equal(reads, 1)
  assert.equal(rotor.children.length, 1)
  const mesh = (rotor.children[0] as THREE.Group).children[0] as THREE.Mesh
  assert.equal(mesh.userData.isHelperVolume, true)
  assert.equal(mesh.userData.supportPaintPart, undefined)

  await buildImportedInstanceMeshes({ ...options, instance: { ...instance, bodyRemoved: true } })
  assert.equal(reads, 1)
  assert.equal(rotor.children.length, 1)
})
