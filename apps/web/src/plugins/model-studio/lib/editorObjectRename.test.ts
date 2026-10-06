import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { seedEmptyEditorState, type EditorInstance } from './editorModel'
import { renameEditorObjectInstances } from './editorObjectRename'

function instance(key: string, objectId: number, source: EditorInstance['source']): EditorInstance {
  return {
    key, source, objectId, instanceId: 0, name: key,
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, parts: [], color: null
  }
}

test('renaming a baked object updates its copies across plates only', () => {
  const state = seedEmptyEditorState()
  const first = instance('first', 12, { kind: 'object' })
  const copy = instance('copy', 12, { kind: 'object' })
  const other = instance('other', 13, { kind: 'object' })
  state.plates[0]!.instances = [first, other]
  const secondPlate = { ...state.plates[0]!, index: 2, plateId: 2, instances: [copy] }

  const renamed = renameEditorObjectInstances([state.plates[0]!, secondPlate], first, 'New name')
  assert.deepEqual(renamed.flatMap((plate) => plate.instances).map((entry) => [entry.name, entry.nameOverridden]), [
    ['New name', true], ['other', undefined], ['New name', true]
  ])
  assert.equal(renamed[0]!.instances[1], other)
})

test('renaming a staged import matches its import id, not its synthetic object id', () => {
  const state = seedEmptyEditorState()
  const source = (importId: string): EditorInstance['source'] => ({ kind: 'import', importId, meshUrl: 'blob:test' })
  const first = instance('first', -1, source('same-import'))
  const copy = instance('copy', -2, source('same-import'))
  const other = instance('other', -1, source('different-import'))
  state.plates[0]!.instances = [first, copy, other]

  const renamed = renameEditorObjectInstances(state.plates, first, 'Imported name')
  assert.deepEqual(renamed[0]!.instances.map((entry) => entry.name), [
    'Imported name', 'Imported name', 'other'
  ])
})
