import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import type { EditorImportStore } from './editorImportStore'
import { commitEditorObjectAssembly, stageEditorObjectAssembly } from './editorObjectAssembly'
import { seedEmptyEditorState, type EditorInstance, type EditorState } from './editorModel'

function objectAt(x: number): THREE.Group {
  const group = new THREE.Group()
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2))
  mesh.position.set(x, 5, 1)
  group.add(mesh)
  group.updateMatrixWorld(true)
  return group
}

test('assembly stages one rebased mesh and preserves the selected world placement', async () => {
  const first = objectAt(10)
  const second = objectAt(30)
  const files: File[] = []
  const store = {
    async stageFile(file: File, normalization: string) {
      assert.equal(normalization, 'object')
      files.push(file)
      return { importId: 'assembly' } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>

  const staged = await stageEditorObjectAssembly([first, second], 'Bracket', store)
  assert.equal(staged.import.importId, 'assembly')
  assert.deepEqual(staged.offset, { x: 20, y: 5, z: 0 })
  assert.deepEqual(files.map((file) => file.name), ['Bracket (assembled).stl'])
  assert.ok(files[0]!.size > 84)
  assert.equal(first.children[0]!.position.x, 10)
  assert.equal(second.children[0]!.position.x, 30)
})

test('assembly refuses a selection with no printable geometry before staging', async () => {
  let stageCalls = 0
  const store = {
    async stageFile() {
      stageCalls++
      return { importId: 'unexpected' } as StagedImport
    }
  } as Pick<EditorImportStore, 'stageFile'>

  await assert.rejects(
    stageEditorObjectAssembly([new THREE.Group(), new THREE.Group()], 'Empty', store),
    /no printable geometry to assemble/
  )
  assert.equal(stageCalls, 0)
})

function stagedAssembly(): StagedImport {
  const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  return {
    importId: 'assembled', name: 'Assembled', format: 'stl', triangleCount: 12,
    bounds, parts: [{ name: 'Assembled', triangleCount: 12, bounds, subtype: null }]
  }
}

function source(key: string, filamentId: number, printable: boolean): EditorInstance {
  return { key, name: key, filamentId, printable } as EditorInstance
}

test('assembly replaces two selected objects with one placed import and reports discarded helpers', async () => {
  const state = seedEmptyEditorState()
  const first = source('first', 3, true)
  const second = source('second', 4, false)
  const untouched = source('untouched', 5, true)
  state.plates[0]!.instances = [first, second, untouched]
  const stateRef: { current: EditorState | null } = { current: state }
  const groups = new Map([['first', objectAt(10)], ['second', objectAt(30)]])
  let updates = 0
  const result = await commitEditorObjectAssembly({
    keys: ['first', 'second'],
    plateIndex: 1,
    stateRef,
    groups,
    importStore: {
      stageFile: async () => stagedAssembly(),
      meshUrl: (id) => `/mesh/${id}`
    },
    countHelperVolumes: (instance) => instance.key === 'first' ? 2 : 1,
    updatePlates: (updater) => {
      updates += 1
      stateRef.current = { ...stateRef.current!, plates: updater(stateRef.current!.plates) }
    }
  })

  assert.equal(updates, 1)
  assert.equal(result?.count, 2)
  assert.equal(result?.discardedHelpers, 3)
  const instances = stateRef.current!.plates[0]!.instances
  assert.equal(instances.length, 2)
  assert.equal(instances[0], untouched)
  assert.equal(instances[1]?.key, result?.key)
  assert.deepEqual(instances[1]?.position.toArray(), [20, 5, 0])
  assert.equal(instances[1]?.filamentId, 3)
  assert.equal(instances[1]?.printable, false)
})

test('assembly ignores a staged result after the source scene changes', async () => {
  const state = seedEmptyEditorState()
  state.plates[0]!.instances = [source('first', 1, true), source('second', 1, true)]
  const stateRef: { current: EditorState | null } = { current: state }
  let finishStage: ((result: StagedImport) => void) | null = null
  let updates = 0
  const pending = commitEditorObjectAssembly({
    keys: ['first', 'second'],
    plateIndex: 1,
    stateRef,
    groups: new Map([['first', objectAt(10)], ['second', objectAt(30)]]),
    importStore: {
      stageFile: () => new Promise<StagedImport>((resolve) => { finishStage = resolve }),
      meshUrl: (id) => `/mesh/${id}`
    },
    countHelperVolumes: () => 0,
    updatePlates: () => { updates += 1 }
  })
  stateRef.current = { ...state, plates: [...state.plates] }
  finishStage!(stagedAssembly())

  assert.equal(await pending, null)
  assert.equal(updates, 0)
  assert.deepEqual(stateRef.current.plates[0]?.instances.map((instance) => instance.key), ['first', 'second'])
})
