import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import type { LayerBandUniforms } from '../editorGeometry'
import type { EditorInstance, EditorState } from './editorModel'
import { createEditorInstanceGroupBuilder } from './editorInstanceGroup'

function instance(source: EditorInstance['source']): EditorInstance {
  return {
    key: 'model', source, objectId: 7, instanceId: 0, name: 'Model',
    position: new THREE.Vector3(1, 2, 0), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), filamentId: 1, printable: true,
    color: '#123456', parts: []
  }
}

function geometry(): THREE.BufferGeometry {
  const mesh = new THREE.BufferGeometry()
  mesh.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
  return mesh
}

function layerBands(): LayerBandUniforms {
  return {
    uFcCount: { value: 0 }, uFcHeights: { value: [] }, uFcColors: { value: [] },
    uPauseCount: { value: 0 }, uPauseHeights: { value: [] }
  }
}

test('a saved object with no source parts survives only when it has session-added volumes', async () => {
  let state = {} as EditorState
  let added = 0
  const build = createEditorInstanceGroupBuilder({
    getState: () => state,
    resolveColorFilamentId: (id) => id,
    getFilamentColors: () => null,
    getLayerBandUniforms: layerBands,
    fetchGeometry: async () => { throw new Error('no parts to fetch') },
    fetchImportGeometry: async () => { throw new Error('no imports to fetch') },
    seedPaintOverlays: () => undefined,
    addBrimEarMarkers: () => undefined,
    addSessionPartMeshes: () => { added += 1 }
  })
  const saved = instance({ kind: 'object' })
  assert.equal(await build(saved), null)
  assert.equal(added, 0)

  state = { addedParts: { 7: [{ key: 'volume' }] } } as unknown as EditorState
  const group = await build(saved)
  assert.ok(group)
  assert.equal(group.userData.instanceKey, 'model')
  assert.deepEqual(group.position.toArray(), [1, 2, 0])
  assert.equal(added, 1)
})

test('a staged import keeps its exact matrix and receives session overlays', async () => {
  let markers = 0
  let added = 0
  const build = createEditorInstanceGroupBuilder({
    getState: () => null,
    resolveColorFilamentId: (id) => id,
    getFilamentColors: () => ({ 1: '#abcdef' }),
    getLayerBandUniforms: layerBands,
    fetchGeometry: async () => { throw new Error('import must not read project geometry') },
    fetchImportGeometry: async () => geometry(),
    seedPaintOverlays: () => undefined,
    addBrimEarMarkers: () => { markers += 1 },
    addSessionPartMeshes: () => { added += 1 }
  })
  const imported = {
    ...instance({ kind: 'import', importId: 'staged', meshUrl: '/mesh', replacedObjectId: -7 }),
    exactMatrix: [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 7, 8, 0]
  }
  const group = await build(imported)
  assert.ok(group)
  assert.equal(group.matrixAutoUpdate, false)
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(group.matrix).toArray(), [7, 8, 0])
  assert.deepEqual((group.userData.rotor as THREE.Group).rotation.toArray().slice(0, 3), [0, 0, 0])
  assert.equal(markers, 1)
  assert.equal(added, 1)
})
