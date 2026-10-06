import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorState
} from './editorModel'
import { planInstanceFilamentAssignment } from './editorInstanceFilamentAssignment'

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'single', name: 'Single', format: 'stl', triangleCount: 1, bounds, parts: []
}

test('whole-object filament assignment reaches linked copies and printable added volumes', () => {
  const state = seedEmptyEditorState()
  const first = instanceFromStagedImport(staged)
  const linked = { ...first, key: 'linked' }
  const other = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(first, linked, other)
  const ownerId = addedPartHostId(first)!
  const otherId = addedPartHostId(other)!
  state.addedParts = {
    [ownerId]: [
      { key: 'printed', subtype: 'normal_part' },
      { key: 'helper', subtype: 'support_blocker' }
    ],
    [otherId]: [{ key: 'unrelated', subtype: 'normal_part' }]
  } as unknown as EditorState['addedParts']

  const assignment = planInstanceFilamentAssignment(state, [first.key], 3)
  assert.ok(assignment)
  assert.deepEqual(assignment.addedPartKeys, ['printed'])
  const next = assignment.mapPlates(state.plates)[0]!.instances
  assert.equal(next[0]!.filamentId, 3)
  assert.equal(next[1]!.filamentId, 3, 'linked copy shares the selected object identity')
  assert.equal(next[2]!.filamentId, other.filamentId, 'other imports keep their material')
})

test('body-only assignment leaves session-added volumes alone', () => {
  const state = seedEmptyEditorState()
  const first = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(first)
  state.addedParts = {
    [addedPartHostId(first)!]: [{ key: 'printed', subtype: 'normal_part' }]
  } as unknown as EditorState['addedParts']

  const assignment = planInstanceFilamentAssignment(state, [first.key], 4, { includeVolumes: false })
  assert.ok(assignment)
  assert.deepEqual(assignment.addedPartKeys, [])
  assert.equal(assignment.mapPlates(state.plates)[0]!.instances[0]!.filamentId, 4)
  assert.equal(planInstanceFilamentAssignment(state, [], 4), null)
})
