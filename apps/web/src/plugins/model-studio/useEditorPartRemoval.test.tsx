import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import * as THREE from 'three'
import type { StagedImport } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { addedPartHostId, instanceFromStagedImport, seedEmptyEditorState,
  type EditorAddedPart, type EditorState } from './lib/editorModel'
import type { PartRef, PartSelection } from './lib/selectionModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorPartRemoval } = await import('./useEditorPartRemoval')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } }
const staged: StagedImport = {
  importId: 'host', name: 'Host', format: 'stl', triangleCount: 12, bounds,
  parts: [{ name: 'Host', triangleCount: 12, bounds, subtype: null }]
}

function addedPart(key: string): EditorAddedPart {
  return {
    key, importId: key, subtype: 'normal_part', name: key, filamentId: 1,
    position: new THREE.Vector3(), rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1), soup: new Float32Array(9)
  }
}

function removalFixture(bodyRemoved: boolean, keys: string[]) {
  const initial = seedEmptyEditorState()
  const host = instanceFromStagedImport(staged)
  host.bodyRemoved = bodyRemoved
  initial.plates[0]!.instances.push(host)
  const hostId = addedPartHostId(host)!
  initial.addedParts = { [hostId]: keys.map(addedPart) }
  const stateRef: { current: EditorState | null } = { current: initial }
  let histories = 0
  let meshRefreshes = 0
  let thumbnails = 0
  const view = renderHook(() => {
    const [state, setState] = useState<EditorState | null>(initial)
    const [gizmoPart, setGizmoPart] = useState<PartRef | null>(null)
    const [partSelection, setPartSelection] = useState<PartSelection | null>(null)
    const [rebuildToken, setRebuildToken] = useState(0)
    stateRef.current = state
    const actions = useEditorPartRemoval({
      stateRef,
      recordHistory: () => { histories += 1 },
      setState, setGizmoPart, setPartSelection, setRebuildToken,
      refreshAddedPartMeshes: () => { meshRefreshes += 1 },
      regenerateThumbnailRef: { current: () => { thumbnails += 1 } }
    })
    return { state, gizmoPart, partSelection, rebuildToken, ...actions }
  })
  return { ...view, hostId, get histories() { return histories },
    get meshRefreshes() { return meshRefreshes }, get thumbnails() { return thumbnails } }
}

test('keyboard removal cannot delete the last printed volume after the body is gone', () => {
  const fixture = removalFixture(true, ['only-volume'])
  const selection = [{ kind: 'added', key: 'only-volume' }] as const
  assert.equal(fixture.result.current.partSelectionRemovable(fixture.hostId, selection), false)
  act(() => fixture.result.current.handleRemoveParts(fixture.hostId, selection))

  assert.deepEqual(fixture.result.current.state?.addedParts?.[fixture.hostId]?.map((part) => part.key), ['only-volume'])
  assert.equal(fixture.histories, 0)
  assert.equal(fixture.meshRefreshes, 0)
  assert.equal(fixture.result.current.rebuildToken, 0)
})

test('mixed body and added removal preserves a surviving printed volume in one history step', () => {
  const fixture = removalFixture(false, ['remove-me', 'survivor'])
  const selection = [{ kind: 'body' }, { kind: 'added', key: 'remove-me' }] as const
  assert.equal(fixture.result.current.partSelectionRemovable(fixture.hostId, selection), true)
  act(() => fixture.result.current.handleRemoveParts(fixture.hostId, selection))

  const state = fixture.result.current.state!
  assert.equal(state.plates[0]?.instances[0]?.bodyRemoved, true)
  assert.deepEqual(state.addedParts?.[fixture.hostId]?.map((part) => part.key), ['survivor'])
  assert.equal(fixture.histories, 1)
  assert.equal(fixture.meshRefreshes, 1)
  assert.equal(fixture.thumbnails, 1)
  assert.equal(fixture.result.current.rebuildToken, 1)
})
