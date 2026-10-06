import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState,
  type EditorAddedPart,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorMaterialAssignments } = await import('./useEditorMaterialAssignments')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'two-part', name: 'Two part', format: '3mf', triangleCount: 24,
  bounds,
  parts: [
    { name: 'Body', triangleCount: 12, bounds, subtype: null },
    { name: 'Helper', triangleCount: 12, bounds, subtype: 'support_blocker' }
  ]
}

function addedPart(key: string, subtype: EditorAddedPart['subtype'], filamentId: number): EditorAddedPart {
  return {
    key, importId: key, subtype, name: key, filamentId,
    position: new THREE.Vector3(), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), soup: new Float32Array(9)
  }
}

function fixture() {
  const initial = seedEmptyEditorState()
  const host = instanceFromStagedImport(staged)
  host.parts[0]!.filamentId = 2
  const copy = { ...host, key: 'linked-copy', parts: host.parts.map((part) => ({ ...part })) }
  initial.plates[0]!.instances.push(host, copy)
  const hostId = addedPartHostId(host)!
  initial.addedParts = {
    [hostId]: [addedPart('printed', 'normal_part', 3), addedPart('helper', 'support_blocker', 4)]
  }

  const stateRef: { current: EditorState | null } = { current: initial }
  const activePlateRef: { current: EditorPlate | null } = { current: initial.plates[0]! }
  let histories = 0
  let meshRefreshes = 0
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(initial)
    stateRef.current = state
    activePlateRef.current = state?.plates[0] ?? null
    const actions = useEditorMaterialAssignments({
      stateRef,
      activePlateRef,
      setState,
      updatePlates: (updater, _kind, history) => {
        if (history?.recordHistory !== false) histories += 1
        setState((current) => current ? { ...current, plates: updater(current.plates) } : current)
      },
      recordHistory: () => { histories += 1 },
      recordHistoryRef: { current: () => { histories += 1 } },
      refreshAddedPartMeshes: () => { meshRefreshes += 1 },
      regenerateThumbnailRef: { current: () => {} }
    })
    return { state, ...actions }
  })
  return {
    ...view, host, hostId,
    get histories() { return histories },
    get meshRefreshes() { return meshRefreshes }
  }
}

test('whole-object material changes linked copies and printable added volumes in one history step', () => {
  const setup = fixture()
  act(() => setup.result.current.reassignInstanceFilament([setup.host.key], 5))

  const state = setup.result.current.state!
  for (const instance of state.plates[0]!.instances) {
    assert.equal(instance.parts[0]?.filamentId, 5)
    assert.equal(instance.parts[1]?.filamentId, null)
  }
  assert.equal(state.addedParts?.[setup.hostId]?.[0]?.filamentId, 5)
  assert.equal(state.addedParts?.[setup.hostId]?.[1]?.filamentId, 4)
  assert.equal(setup.histories, 1)
  assert.equal(setup.meshRefreshes, 1)
})

test('body-only material changes leave an unselected added volume alone', () => {
  const setup = fixture()
  act(() => setup.result.current.handleChangeMemberFilament(setup.hostId, [{ kind: 'body' }], 6))

  assert.equal(setup.result.current.state?.plates[0]?.instances[0]?.parts[0]?.filamentId, 6)
  assert.equal(setup.result.current.state?.addedParts?.[setup.hostId]?.[0]?.filamentId, 3)
  assert.equal(setup.histories, 1)
  assert.equal(setup.meshRefreshes, 0)
})

test('mixed baked and added selection has one history step and helper-only selection has no material', () => {
  const setup = fixture()
  assert.equal(setup.result.current.partsAcceptFilament(setup.hostId, [
    { kind: 'baked', partIndex: 1 }, { kind: 'added', key: 'helper' }
  ]), false)
  assert.equal(setup.result.current.partsAcceptFilament(setup.hostId, [
    { kind: 'baked', partIndex: 0 }, { kind: 'added', key: 'printed' }
  ]), true)

  act(() => setup.result.current.handleChangeMemberFilament(setup.hostId, [
    { kind: 'baked', partIndex: 0 }, { kind: 'added', key: 'printed' }
  ], 7))
  assert.equal(setup.result.current.state?.plates[0]?.instances[0]?.parts[0]?.filamentId, 7)
  assert.equal(setup.result.current.state?.addedParts?.[setup.hostId]?.[0]?.filamentId, 7)
  assert.equal(setup.histories, 1)
})
