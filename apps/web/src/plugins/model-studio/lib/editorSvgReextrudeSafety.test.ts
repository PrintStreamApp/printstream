import assert from 'node:assert/strict'
import test from 'node:test'
import type { StagedImport } from '@printstream/shared'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorAddedPart,
  type EditorInstancePart
} from './editorModel'
import { prepareSvgReextrudeSafety } from './editorSvgReextrudeSafety'

const bounds = { min: { x: -1, y: -1, z: 0 }, max: { x: 1, y: 1, z: 2 } }
const staged: StagedImport = {
  importId: 'source', name: 'Source', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Source', triangleCount: 12, bounds, subtype: null }]
}

function hostState() {
  const state = seedEmptyEditorState()
  const host = instanceFromStagedImport(staged)
  host.parts = [{ partIndex: 0, subtype: 'normal_part' } as EditorInstancePart]
  state.plates[0]!.instances.push(host)
  const hostId = addedPartHostId(host)!
  return { state, hostId }
}

test('a nonprinting SVG replacement cannot remove the only baked printed part', () => {
  const { state, hostId } = hostState()
  const plan = {
    replace: [{ survivor: { kind: 'baked' as const, partIndex: 0, pieceIndex: 0,
      transform: [], subtype: 'normal_part', filamentId: null } }],
    add: [], remove: []
  }
  const refused = prepareSvgReextrudeSafety(state, hostId, 'negative_part', plan)
  assert.equal(refused.refused, true)
  assert.equal(refused.removedState, null)
  assert.equal(state.plates[0]!.instances[0]!.parts.length, 1)

  const printed = prepareSvgReextrudeSafety(state, hostId, 'normal_part', plan)
  assert.equal(printed.refused, false)
  assert.deepEqual([...printed.removedBaked], [0])
  assert.equal(printed.removedState?.plates[0]!.instances[0]!.parts.length, 0)
  assert.equal(state.plates[0]!.instances[0]!.parts.length, 1)
})

test('the safety check counts retained parts after retyping and removal', () => {
  const { state, hostId } = hostState()
  state.addedParts = {
    [hostId]: [
      { key: 'retained', subtype: 'normal_part' } as EditorAddedPart,
      { key: 'orphan', subtype: 'normal_part' } as EditorAddedPart
    ]
  }
  const baked = { kind: 'baked' as const, partIndex: 0, pieceIndex: 0,
    transform: [], subtype: 'normal_part', filamentId: null }
  const plan = {
    replace: [
      { survivor: baked },
      { survivor: { kind: 'added' as const, key: 'retained', pieceIndex: 1 } }
    ],
    add: [],
    remove: [{ kind: 'added' as const, key: 'orphan', pieceIndex: 2 }]
  }

  const result = prepareSvgReextrudeSafety(state, hostId, 'negative_part', plan)
  assert.equal(result.otherPrintedParts, 0)
  assert.equal(result.refused, true)
  assert.deepEqual([...result.droppedAdded], ['orphan'])

  state.addedParts[hostId]!.push({ key: 'independent', subtype: 'normal_part' } as EditorAddedPart)
  const allowed = prepareSvgReextrudeSafety(state, hostId, 'negative_part', plan)
  assert.equal(allowed.otherPrintedParts, 1)
  assert.equal(allowed.refused, false)
})
