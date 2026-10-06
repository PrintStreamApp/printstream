import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import {
  addedPartHostId,
  duplicateInstance,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorState
} from './editorModel'
import { replaceEditorGeometry } from './editorGeometryReplacement'

const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
function staged(importId: string): StagedImport {
  return {
    importId, name: importId, format: 'stl', triangleCount: 24, bounds,
    parts: [
      { name: 'Body', triangleCount: 12, bounds, subtype: null },
      { name: 'Helper', triangleCount: 12, bounds, subtype: null }
    ]
  }
}

test('replacement swaps every linked copy with one history step and drops old helper volumes', () => {
  const state = seedEmptyEditorState()
  const first = instanceFromStagedImport(staged('old'))
  const second = duplicateInstance(first)
  first.position.x = 12
  second.position.x = 30
  first.parts[1]!.subtype = 'modifier_part'
  second.parts[1]!.subtype = 'modifier_part'
  state.plates[0]!.instances.push(first, second)
  const hostId = addedPartHostId(first)!
  state.addedParts = { [hostId]: [{ key: 'old-helper' }] } as unknown as EditorState['addedParts']
  state.removedParts = { [hostId]: [0] }
  const stateRef = { current: state as EditorState | null }
  let histories = 0
  let selected: string | null = null

  const replaced = replaceEditorGeometry({
    key: first.key,
    staged: staged('revised'),
    stateRef,
    setState: (update) => {
      stateRef.current = typeof update === 'function' ? update(stateRef.current) : update
    },
    updatePlates: (update, kind, options) => {
      assert.equal(kind, 'structure')
      assert.notEqual(options.recordHistory, false)
      assert.equal(stateRef.current?.addedParts?.[hostId]?.length, 1,
        'history must be recorded before old helper volumes are cleared')
      histories += 1
      const current = stateRef.current!
      // Model a synchronous state replacement: cleanup must target the post-checkpoint state.
      stateRef.current = {
        ...current,
        plates: update(current.plates),
        addedParts: { ...current.addedParts },
        removedParts: { ...current.removedParts }
      }
    },
    meshUrl: (id) => `/mesh/${id}`,
    worldFootprintCenterFor: () => null,
    selectReplacement: (key) => { selected = key }
  })

  assert.equal(replaced, true)
  assert.equal(histories, 1)
  const copies = stateRef.current?.plates[0]?.instances ?? []
  assert.equal(copies.length, 2)
  assert.deepEqual(copies.map((copy) => copy.source.kind === 'import' && copy.source.importId),
    ['revised', 'revised'])
  assert.deepEqual(copies.map((copy) => copy.position.x), [12, 30])
  assert.deepEqual(copies.map((copy) => copy.parts[1]?.subtype), ['modifier_part', 'modifier_part'])
  assert.equal(selected, copies[0]?.key)
  assert.equal(stateRef.current?.addedParts?.[hostId], undefined)
  assert.equal(stateRef.current?.removedParts?.[hostId], undefined)
})

test('replacement of an unknown instance leaves state and selection alone', () => {
  const state = seedEmptyEditorState()
  const replaced = replaceEditorGeometry({
    key: 'absent', staged: staged('new'), stateRef: { current: state },
    setState: () => assert.fail('missing replacement changed state'),
    updatePlates: () => assert.fail('missing replacement changed plates'),
    meshUrl: (id) => `/mesh/${id}`,
    worldFootprintCenterFor: () => null,
    selectReplacement: () => assert.fail('missing replacement changed selection')
  })
  assert.equal(replaced, false)
})
