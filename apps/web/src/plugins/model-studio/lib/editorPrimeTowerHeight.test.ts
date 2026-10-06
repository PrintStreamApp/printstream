import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { LibraryThreeMfPrimeTower, StagedImport } from '@printstream/shared'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'
import { computeEditorPrimeTowerHeight, shouldShowEditorPrimeTower } from './editorPrimeTowerHeight'

test('prime tower presence follows project materials and forced tower conditions', () => {
  const tower = {
    sizing: { needWipeTower: false, spiralMode: false }
  } as LibraryThreeMfPrimeTower

  assert.equal(shouldShowEditorPrimeTower(null, 3), false)
  assert.equal(shouldShowEditorPrimeTower(tower, 1), false)
  assert.equal(shouldShowEditorPrimeTower(tower, 2), true)

  tower.sizing.spiralMode = true
  assert.equal(shouldShowEditorPrimeTower(tower, 2), false)
  tower.sizing.needWipeTower = true
  assert.equal(shouldShowEditorPrimeTower(tower, 1), true)
})

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
const staged: StagedImport = {
  importId: 'solid', name: 'Solid', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Body', triangleCount: 12, bounds, subtype: null }]
}

/** Build the live geometry used by the height rule; the import metadata is intentionally separate. */
function modelAtHeight(height: number, helperHeight = 0): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(10, 10, height), new THREE.MeshBasicMaterial())
  body.position.z = height / 2
  group.add(body)

  if (helperHeight > 0) {
    const helper = new THREE.Mesh(new THREE.BoxGeometry(10, 10, helperHeight), new THREE.MeshBasicMaterial())
    helper.position.z = helperHeight / 2
    helper.userData.isHelperVolume = true
    group.add(helper)
  }
  return group
}

test('prime tower ends at the second material or last layer change, excluding taller helpers', () => {
  const state = seedEmptyEditorState()
  const tall = instanceFromStagedImport(staged)
  const short = instanceFromStagedImport(staged)
  tall.filamentId = 1
  short.filamentId = 2
  state.plates[0]!.instances.push(tall, short)
  const groups = new Map([
    [tall.key, modelAtHeight(60, 100)],
    [short.key, modelAtHeight(20)]
  ])

  assert.equal(computeEditorPrimeTowerHeight(state, groups, 1), 20)
  state.plates[0]!.filamentChangesOverride = [{ z: 35, filamentId: 2 }]
  assert.equal(computeEditorPrimeTowerHeight(state, groups, 1), 35)
  state.plates[0]!.filamentChangesOverride = [{ z: 90, filamentId: 2 }]
  assert.equal(computeEditorPrimeTowerHeight(state, groups, 1), 60, 'purge height is capped at printable geometry')
})

test('baked support material follows source plate identity after a live reorder', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  instance.filamentId = 1
  state.plates[0]!.instances.push(instance)
  state.plates[0]!.index = 2
  state.plates[0]!.sourcePlateIndex = 7
  const groups = new Map([[instance.key, modelAtHeight(60)]])
  const bakedPlates = [
    { index: 2, filaments: [{ id: 1 }] },
    { index: 7, filaments: [{ id: 1 }, { id: 3 }] }
  ]

  assert.equal(computeEditorPrimeTowerHeight(state, groups, 2, bakedPlates), 60)
  assert.equal(computeEditorPrimeTowerHeight(state, groups, 1, bakedPlates), 0)
  assert.equal(computeEditorPrimeTowerHeight(state, new Map(), 2, bakedPlates), 0)
})
