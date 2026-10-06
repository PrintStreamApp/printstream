import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { commitHostedText } from './editorHostedTextCommit'
import { addedPartHostId, instanceFromStagedImport, seedEmptyEditorState } from './editorModel'
import type { EditorImportStore } from './editorImportStore'
import type { TextToolValue } from './textToolValue'

function staged(importId: string): StagedImport {
  const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  return {
    importId, name: importId, format: 'stl', triangleCount: 12, bounds,
    parts: [{ name: importId, triangleCount: 12, bounds, subtype: null }]
  }
}

test('hosted text stages before creating a part and reuses unchanged geometry', async () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged('host'))
  state.plates[0]!.instances.push(instance)
  const hostId = addedPartHostId(instance)!
  const group = new THREE.Group()
  const soup = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const face = { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false }
  const value: TextToolValue = {
    text: 'A', family: face.family, bold: false, italic: false,
    fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
    embeddedDepth: 0.5, surfaceMode: 'surface', operation: 'normal_part'
  }
  let stageCount = 0
  const store = {
    stageFile: async () => {
      assert.equal(state.addedParts?.[hostId]?.length ?? 0, 0)
      stageCount += 1
      return staged(`text-${stageCount}`)
    }
  } as unknown as EditorImportStore
  let editingPartKey: string | null = null
  let selectedKey: string | null = null
  let refreshes = 0
  const options = {
    stateRef: { current: state }, instance, group, hostId,
    pointed: null, promotingRef: { current: null }, value,
    buildPlacement: async () => ({
      face, soup, position: new THREE.Vector3(), rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1), rotor: group
    }),
    importStore: store,
    setEditingPartKey: (key: string | null) => { editingPartKey = key },
    setEditingHost: () => {},
    selectAddedPart: (_id: number, key: string) => { selectedKey = key },
    clearSelectedPart: () => {},
    setState: () => {},
    refreshAddedPartMeshes: () => { refreshes += 1 },
    regenerateThumbnail: () => {}
  }

  await commitHostedText({ ...options, editingPartKey: null })
  assert.equal(stageCount, 1)
  assert.equal(state.addedParts?.[hostId]?.length, 1)
  assert.equal(state.addedParts?.[hostId]?.[0]?.importId, 'text-1')
  assert.equal(selectedKey, editingPartKey)

  await commitHostedText({ ...options, editingPartKey, value: { ...value, text: 'B' } })
  assert.equal(stageCount, 1)
  assert.equal(state.addedParts?.[hostId]?.length, 1)
  assert.equal(state.addedParts?.[hostId]?.[0]?.name, 'B')
  assert.equal(state.addedParts?.[hostId]?.[0]?.importId, 'text-1')
  assert.equal(refreshes, 2)
})

test('first edit promotes a baked text part while retaining its saved placement', async () => {
  let state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged('host'))
  const transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 20, 30]
  instance.parts.push({
    entryPath: '3D/Objects/object_1.model', componentObjectId: 5, partIndex: 0,
    transform, filamentId: 1, name: 'Saved text', color: null, subtype: null
  })
  state.plates[0]!.instances.push(instance)
  const hostId = addedPartHostId(instance)!
  const group = new THREE.Group()
  const face = { id: 'dejavu-sans', family: 'DejaVu Sans', bold: false, italic: false }
  const value: TextToolValue = {
    text: 'Edited', family: face.family, bold: false, italic: false,
    fontSize: 10, thickness: 2, textGap: 0, rotateAngle: 0,
    embeddedDepth: 0.5, surfaceMode: 'surface', operation: 'normal_part'
  }
  const promotingRef = { current: { hostId, partIndex: 0, transform } }
  const store = {
    stageFile: async () => staged('replacement')
  } as unknown as EditorImportStore

  await commitHostedText({
    stateRef: { current: state }, instance, group, hostId,
    editingPartKey: null, pointed: null, promotingRef, value,
    buildPlacement: async () => ({
      face,
      soup: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      position: new THREE.Vector3(), rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1), rotor: group
    }),
    importStore: store,
    setEditingPartKey: () => {},
    setEditingHost: () => {},
    selectAddedPart: () => {},
    clearSelectedPart: () => {},
    setState: (next) => { state = typeof next === 'function' ? next(state)! : next! },
    refreshAddedPartMeshes: () => {},
    regenerateThumbnail: () => {}
  })

  assert.equal(promotingRef.current, null)
  assert.deepEqual(state.addedParts?.[hostId]?.[0]?.position.toArray(), [10, 20, 30])
  assert.deepEqual(state.removedParts?.[hostId], [0])
  assert.equal(state.plates[0]?.instances[0]?.parts.length, 0)
})
