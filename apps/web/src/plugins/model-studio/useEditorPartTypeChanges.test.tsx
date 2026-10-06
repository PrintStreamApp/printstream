import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { addedPartHostId, instanceFromStagedImport, partSlotKey,
  seedEmptyEditorState, type EditorAddedPart, type EditorState } from './lib/editorModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPartTypeChanges } = await import('./useEditorPartTypeChanges')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'two-part', name: 'Two part', format: '3mf', triangleCount: 24,
  bounds,
  parts: [
    { name: 'A', triangleCount: 12, bounds, subtype: null },
    { name: 'B', triangleCount: 12, bounds, subtype: null }
  ]
}

function fixture() {
  const initial = seedEmptyEditorState()
  const host = instanceFromStagedImport(staged)
  host.parts[0]!.filamentId = 2
  host.parts[0]!.color = '#ff0000'
  const copy = { ...host, key: 'linked-copy', parts: host.parts.map((part) => ({ ...part })) }
  initial.plates[0]!.instances.push(host, copy)
  const hostId = addedPartHostId(host)!
  const addedPart: EditorAddedPart = {
    key: 'added', importId: 'added', subtype: 'normal_part', name: 'Added', filamentId: 3,
    position: new THREE.Vector3(), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), soup: new Float32Array(9)
  }
  initial.addedParts = { [hostId]: [addedPart] }
  const stateRef: { current: EditorState | null } = { current: initial }
  let histories = 0
  let meshRefreshes = 0
  let thumbnails = 0
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(initial)
    const [rebuildToken, setRebuildToken] = useState(0)
    stateRef.current = state
    const actions = useEditorPartTypeChanges({
      stateRef, setState, setRebuildToken,
      recordHistory: () => { histories += 1 },
      recordHistoryRef: { current: () => { histories += 1 } },
      refreshAddedPartMeshes: () => { meshRefreshes += 1 },
      regenerateThumbnailRef: { current: () => { thumbnails += 1 } }
    })
    return { state, rebuildToken, ...actions }
  })
  return {
    ...view, hostId,
    get histories() { return histories },
    get meshRefreshes() { return meshRefreshes },
    get thumbnails() { return thumbnails }
  }
}

test('baked type changes reach linked copies and clear material on a helper subtype', () => {
  const setup = fixture()
  act(() => setup.result.current.handleChangeOnePartType(setup.hostId, 0, 'support_blocker'))

  const state = setup.result.current.state!
  for (const instance of state.plates[0]!.instances) {
    assert.equal(instance.parts[0]?.subtype, 'support_blocker')
    assert.equal(instance.parts[0]?.filamentId, null)
    assert.equal(instance.parts[0]?.color, null)
    assert.equal(instance.parts[1]?.subtype, null)
  }
  assert.equal(state.partTypeChanges?.[partSlotKey(setup.hostId, 0)], 'support_blocker')
  assert.equal(setup.histories, 1)
  assert.equal(setup.result.current.rebuildToken, 1)
})

test('added type changes refresh once and leave a no-op retype out of history', () => {
  const setup = fixture()
  act(() => setup.result.current.handleChangeAddedPartTypes(['added'], 'negative_part'))
  assert.equal(setup.result.current.state?.addedParts?.[setup.hostId]?.[0]?.subtype, 'negative_part')
  assert.equal(setup.result.current.state?.addedParts?.[setup.hostId]?.[0]?.filamentId, null)
  assert.equal(setup.histories, 1)
  assert.equal(setup.meshRefreshes, 1)
  assert.equal(setup.thumbnails, 1)

  act(() => setup.result.current.handleChangeAddedPartTypes(['added'], 'negative_part'))
  assert.equal(setup.histories, 1)
  assert.equal(setup.meshRefreshes, 1)
})
