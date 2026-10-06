import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { partSlotKey, type EditorInstance, type EditorState } from './editorModel'
import type { LayerBandUniforms } from '../editorGeometry'
import { buildSavedInstanceMeshes } from './editorSavedInstanceMeshes'

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]

function geometry(): THREE.BufferGeometry {
  const mesh = new THREE.BufferGeometry()
  mesh.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  return mesh
}

function savedInstance(): EditorInstance {
  return {
    key: 'saved', source: { kind: 'object' }, objectId: 7, instanceId: 0, name: 'Saved',
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, color: '#123456', parts: [
      { entryPath: 'first', componentObjectId: 11, partIndex: 0, transform: IDENTITY,
        filamentId: 2, name: 'Body', color: null, subtype: 'normal_part' },
      { entryPath: 'second', componentObjectId: 12, partIndex: 1, transform: IDENTITY,
        filamentId: null, name: 'Blocker', color: null, subtype: 'support_blocker' }
    ]
  }
}

function layerBands(): LayerBandUniforms {
  return {
    uFcCount: { value: 0 }, uFcHeights: { value: [] }, uFcColors: { value: [] },
    uPauseCount: { value: 0 }, uPauseHeights: { value: [] }
  }
}

test('saved parts keep source order when geometry resolves out of order', async () => {
  const pending = new Map<string, (geometries: Map<number, THREE.BufferGeometry>) => void>()
  const rotor = new THREE.Group()
  const paintKeys: string[] = []
  const building = buildSavedInstanceMeshes({
    instance: savedInstance(),
    rotor,
    placement: new THREE.Matrix4(),
    meshColor: '#123456',
    getState: () => null,
    resolveColorFilamentId: (id) => id,
    getFilamentColors: () => ({ 2: '#abcdef' }),
    getLayerBandUniforms: layerBands,
    fetchGeometry: (entryPath) => new Promise((resolve) => { pending.set(entryPath, resolve) }),
    fetchImportGeometry: async () => { throw new Error('unexpected replacement read') },
    seedPaintOverlays: (_mesh, key) => { paintKeys.push(key) }
  })
  assert.deepEqual([...pending.keys()], ['first', 'second'])
  pending.get('second')!(new Map([[12, geometry()]]))
  pending.get('first')!(new Map([[11, geometry()]]))

  assert.equal(await building, 2)
  assert.deepEqual(rotor.children.map((group) => group.userData.partRef), [
    { componentObjectId: 11, partIndex: 0 },
    { componentObjectId: 12, partIndex: 1 }
  ])
  const body = (rotor.children[0] as THREE.Group).children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  const blocker = (rotor.children[1] as THREE.Group).children[0] as THREE.Mesh
  assert.equal(body.material.color.getHexString(), 'abcdef')
  assert.deepEqual(body.userData.supportPaintPart, { objectId: 7, componentObjectId: 11 })
  assert.equal(blocker.userData.isHelperVolume, true)
  assert.equal(blocker.userData.supportPaintPart, undefined)
  assert.equal(paintKeys.length, 1)
})

test('saved part replacement reads its staged geometry instead of the source entry', async () => {
  const instance = { ...savedInstance(), parts: savedInstance().parts.slice(0, 1) }
  const state = { partMeshReplacements: { [partSlotKey(7, 0)]: 'replacement' } } as EditorState
  const reads: string[] = []
  const placed = await buildSavedInstanceMeshes({
    instance,
    rotor: new THREE.Group(),
    placement: new THREE.Matrix4(),
    meshColor: '#123456',
    getState: () => state,
    resolveColorFilamentId: (id) => id,
    getFilamentColors: () => null,
    getLayerBandUniforms: layerBands,
    fetchGeometry: async () => { throw new Error('source geometry must not be used') },
    fetchImportGeometry: async (id) => { reads.push(id); return geometry() },
    seedPaintOverlays: () => undefined
  })
  assert.equal(placed, 1)
  assert.deepEqual(reads, ['replacement'])
})
