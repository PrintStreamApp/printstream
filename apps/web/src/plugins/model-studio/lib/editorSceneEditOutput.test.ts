import assert from 'node:assert/strict'
import test from 'node:test'
import { seedEmptyEditorState } from './editorModel'
import { buildEditorSceneEdit } from './editorSceneEditOutput'

test('emitted edit always declares the global bed type even without slice settings', () => {
  const edit = buildEditorSceneEdit(seedEmptyEditorState())
  assert.equal(Object.hasOwn(edit, 'plateType'), true)
  assert.equal(edit.plateType, null)
  assert.equal(edit.filaments, undefined)
})

test('save and slice output preserve pinned material aliases and renumber session print order', () => {
  const state = seedEmptyEditorState()
  state.baseFilamentIds = { 1: 7 }
  state.plates[0]!.firstLayerFilamentSequence = [7]
  const edit = buildEditorSceneEdit(state, {
    projectFilaments: [{ projectFilamentId: 7 }],
    plateType: ' textured ',
    desiredFilaments: [{ color: '#ffffff' }]
  }, { thumbnails: [{ plateIndex: 1, png: 'test-png' }] })

  assert.equal(edit.plateType, 'textured')
  assert.deepEqual(edit.plates[0]?.firstLayerFilamentSequence, [1])
  assert.deepEqual(edit.filaments?.[0]?.replacedSourceIndices, [0])
  assert.deepEqual(edit.plateThumbnails, [{ plateIndex: 1, png: 'test-png' }])
  assert.deepEqual(state.plates[0]!.firstLayerFilamentSequence, [7])
})
