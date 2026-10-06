import assert from 'node:assert/strict'
import test from 'node:test'
import type { SceneEditPartSubtype } from '@printstream/shared'
import { changeEditorMemberFilament, changeEditorMemberTypes } from './editorMemberChanges'
import { addedPartHostId, BODY_PART_INDEX, instanceFromStagedImport, seedEmptyEditorState } from './editorModel'

test('mixed body, baked, and added type changes share one history checkpoint', () => {
  const writes: Array<{ owner: string; targets: unknown; history: boolean }> = []
  let history = 0
  const subtype: SceneEditPartSubtype = 'negative_part'
  changeEditorMemberTypes({
    objectId: 12,
    members: [{ kind: 'body' }, { kind: 'baked', partIndex: 4 }, { kind: 'added', key: 'extra' }],
    subtype,
    recordHistory: () => { history += 1 },
    changeBaked: (targets, received, options) => {
      assert.equal(received, subtype)
      if (options?.recordHistory !== false) history += 1
      writes.push({ owner: 'baked', targets, history: options?.recordHistory !== false })
    },
    changeAdded: (keys, received, options) => {
      assert.equal(received, subtype)
      if (options?.recordHistory !== false) history += 1
      writes.push({ owner: 'added', targets: keys, history: options?.recordHistory !== false })
    }
  })

  assert.equal(history, 1)
  assert.deepEqual(writes, [
    { owner: 'baked', targets: [{ objectId: 12, partIndex: BODY_PART_INDEX }, { objectId: 12, partIndex: 4 }], history: false },
    { owner: 'added', targets: ['extra'], history: false }
  ])
})

test('single-seam type change keeps its own checkpoint and an empty selection makes none', () => {
  let history = 0
  const options = {
    objectId: 12,
    subtype: 'modifier' as SceneEditPartSubtype,
    recordHistory: () => { history += 1 },
    changeBaked: () => assert.fail('no baked target'),
    changeAdded: (_keys: string[], _subtype: SceneEditPartSubtype, choice?: { recordHistory?: boolean }) => {
      if (choice?.recordHistory !== false) history += 1
    }
  }
  changeEditorMemberTypes({ ...options, members: [{ kind: 'added', key: 'extra' }] })
  changeEditorMemberTypes({ ...options, members: [] })
  assert.equal(history, 1)
})

test('mixed material change excludes unselected volumes and records one checkpoint', () => {
  const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
  const state = seedEmptyEditorState()
  const owner = instanceFromStagedImport({
    importId: 'source', name: 'Model', format: 'stl', triangleCount: 12, bounds,
    parts: [{ name: 'Body', triangleCount: 12, bounds, subtype: null }]
  })
  state.plates[0]!.instances.push(owner)
  const objectId = addedPartHostId(owner)!
  const writes: Array<{ owner: string; targets: unknown; history: boolean }> = []
  let history = 0
  changeEditorMemberFilament({
    objectId,
    members: [{ kind: 'body' }, { kind: 'added', key: 'selected-volume' }],
    filamentId: 3,
    state,
    recordHistory: () => { history += 1 },
    changeBody: (keys, filamentId, choice) => {
      assert.equal(filamentId, 3)
      assert.equal(choice.includeVolumes, false)
      if (choice.recordHistory !== false) history += 1
      writes.push({ owner: 'body', targets: keys, history: choice.recordHistory !== false })
    },
    changeBaked: () => assert.fail('no baked target'),
    changeAdded: (keys, filamentId, choice) => {
      assert.equal(filamentId, 3)
      if (choice?.recordHistory !== false) history += 1
      writes.push({ owner: 'added', targets: keys, history: choice?.recordHistory !== false })
    }
  })

  assert.equal(history, 1)
  assert.deepEqual(writes, [
    { owner: 'body', targets: [owner.key], history: false },
    { owner: 'added', targets: ['selected-volume'], history: false }
  ])
})
