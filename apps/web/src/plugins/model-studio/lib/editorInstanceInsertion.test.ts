import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { insertEditorInstance, type EditorInstanceInsertionOptions } from './editorInstanceInsertion'
import { instanceFromStagedImport, seedEmptyEditorState } from './editorModel'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }
const staged: StagedImport = {
  importId: 'solid', name: 'Solid', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Body', triangleCount: 12, bounds, subtype: null }]
}

test('new mesh centre clears an occupied live footprint and preserves the history choice', () => {
  const state = seedEmptyEditorState()
  const occupant = instanceFromStagedImport(staged)
  const added = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(occupant)
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 20), new THREE.MeshBasicMaterial())
  mesh.position.z = 10
  group.add(mesh)
  const groups = new Map([[occupant.key, group]])
  const events: string[] = []
  const options: EditorInstanceInsertionOptions = {
    instance: added,
    footprint: { center: { x: 5, y: 5 }, size: { width: 10, depth: 10 } },
    recordHistory: false,
    projectFilamentCount: 1,
    activePlateIndex: 1,
    state,
    groups,
    updatePlates: (updater, kind, history) => {
      assert.equal(kind, 'structure')
      assert.equal(history.recordHistory, false)
      state.plates = updater(state.plates)
      events.push('update')
    },
    selectInstance: (key) => { events.push(`select:${key}`) }
  }

  assert.equal(insertEditorInstance(options), true)
  const centre = { x: added.position.x + 5, y: added.position.y + 5 }
  assert.ok(
    centre.x - 5 - 6 >= 20 || centre.x + 5 + 6 <= -20
    || centre.y - 5 - 6 >= 20 || centre.y + 5 + 6 <= -20,
    'the imported mesh centre must leave clearance around the occupied geometry'
  )
  assert.deepEqual(state.plates[0]!.instances, [occupant, added])
  assert.deepEqual(events, ['update', `select:${added.key}`])
})

test('no project material prevents any placement, history, or selection change', () => {
  const state = seedEmptyEditorState()
  const added = instanceFromStagedImport(staged)
  const initialPosition = added.position.clone()
  const options: EditorInstanceInsertionOptions = {
    instance: added,
    projectFilamentCount: 0,
    activePlateIndex: 1,
    state,
    groups: new Map(),
    updatePlates: () => assert.fail('a refused add must not update plates'),
    selectInstance: () => assert.fail('a refused add must not select the object')
  }

  assert.equal(insertEditorInstance(options), false)
  assert.equal(state.plates[0]!.instances.length, 0)
  assert.deepEqual(added.position, initialPosition)
})
