import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import { removeEditorText } from './editorTextRemoval'
import { instanceFromStagedImport, seedEmptyEditorState, type EditorState } from './editorModel'

installJsdomGlobals()

const staged: StagedImport = {
  importId: 'text-object', name: 'Text', format: 'stl', triangleCount: 1,
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  parts: [{ name: 'Text', triangleCount: 1,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, subtype: null }]
}

test('standalone Text removal uses one plate history checkpoint', () => {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  let histories = 0
  let editingObject: string | null = instance.key
  let selectedObject: string | null = instance.key
  let thumbnails = 0

  removeEditorText({
    objectKey: instance.key, partKey: null, activePlateIndex: 1,
    stateRef: { current: state }, settleRef: { current: undefined },
    updatePlates: (updater) => {
      histories += 1
      state.plates = updater(state.plates)
    },
    setEditingObject: (key) => { editingObject = key },
    setEditingPartKey: () => assert.fail('standalone removal changed the part key'),
    selectObject: (key) => { selectedObject = key },
    clearSelectedPart: () => assert.fail('standalone removal changed part selection'),
    refreshAddedPartMeshes: () => assert.fail('standalone removal rebuilt part meshes'),
    regenerateThumbnail: () => { thumbnails += 1 }
  })

  assert.equal(state.plates[0]?.instances.length, 0)
  assert.equal(histories, 1)
  assert.equal(editingObject, null)
  assert.equal(selectedObject, null)
  assert.equal(thumbnails, 1)
})

test('hosted Text removal clears only its part and cancels delayed staging', async () => {
  const state = seedEmptyEditorState()
  state.addedParts = {
    1: [{ key: 'text-1' }, { key: 'other-part' }],
    2: [{ key: 'other-host' }]
  } as unknown as EditorState['addedParts']
  let settled = false
  const timer = window.setTimeout(() => { settled = true }, 0)
  let editingPartKey: string | null = 'text-1'
  let clearedSelection = false
  let refreshes = 0

  removeEditorText({
    objectKey: null, partKey: 'text-1', activePlateIndex: 0,
    stateRef: { current: state }, settleRef: { current: timer },
    updatePlates: () => assert.fail('hosted removal changed the plate'),
    setEditingObject: () => assert.fail('hosted removal changed object editing'),
    setEditingPartKey: (key) => { editingPartKey = key },
    selectObject: () => assert.fail('hosted removal changed object selection'),
    clearSelectedPart: () => { clearedSelection = true },
    refreshAddedPartMeshes: () => { refreshes += 1 },
    regenerateThumbnail: () => {}
  })

  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false)
  assert.deepEqual(state.addedParts?.[1]?.map((part) => part.key), ['other-part'])
  assert.deepEqual(state.addedParts?.[2]?.map((part) => part.key), ['other-host'])
  assert.equal(editingPartKey, null)
  assert.equal(clearedSelection, true)
  assert.equal(refreshes, 1)
})
