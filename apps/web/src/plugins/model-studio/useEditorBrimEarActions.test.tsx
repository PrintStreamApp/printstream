import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { StagedImport } from '@printstream/shared'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import {
  addedPartHostId,
  instanceFromStagedImport,
  seedEmptyEditorState
} from './lib/editorModel'
import { BRIM_EAR_MARKER_NAME } from './editorGeometry'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorBrimEarActions } = await import('./useEditorBrimEarActions')

afterEach(cleanup)
after(() => dom.window.close())

const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }
const staged: StagedImport = {
  importId: 'cube', name: 'Cube', format: 'stl', triangleCount: 12,
  bounds, parts: [{ name: 'Cube', triangleCount: 12, bounds, subtype: null }]
}

function fixture(selected = true) {
  const state = seedEmptyEditorState()
  const instance = instanceFromStagedImport(staged)
  state.plates[0]!.instances.push(instance)
  const group = new THREE.Group()
  group.position.set(10, 20, 5)
  group.updateWorldMatrix(true, false)
  const hostId = addedPartHostId(instance)!
  let histories = 0
  let thumbnails = 0
  const view = renderHook(() => useEditorBrimEarActions({
    stateRef: { current: state },
    activePlateRef: { current: state.plates[0]! },
    groupByKeyRef: { current: new Map([[instance.key, group]]) },
    selectedKeyRef: { current: selected ? instance.key : null },
    brimEarDiameterRef: { current: 8 },
    recordHistoryRef: { current: () => { histories += 1 } },
    regenerateThumbnailRef: { current: () => { thumbnails += 1 } }
  }))
  return {
    ...view, state, group, hostId,
    get histories() { return histories },
    get thumbnails() { return thumbnails }
  }
}

test('an ear edit projects onto the bed, refreshes markers, and records one history step', () => {
  const setup = fixture()
  act(() => setup.result.current.editSelectedBrimEars({
    kind: 'add', group: setup.group, worldPoint: new THREE.Vector3(12, 23, 40)
  }))

  const ear = setup.state.brimEars?.[setup.hostId]?.[0]
  assert.ok(ear)
  assert.equal(ear.x, 2)
  assert.equal(ear.y, 3)
  assert.equal(ear.radius, 4)
  assert.equal(setup.histories, 1)
  assert.equal(setup.thumbnails, 1)
  assert.equal(setup.group.children.filter((child) => child.name === BRIM_EAR_MARKER_NAME).length, 1)

  act(() => setup.result.current.refreshBrimEarMarkers())
  assert.equal(setup.group.children.filter((child) => child.name === BRIM_EAR_MARKER_NAME).length, 1)

  act(() => setup.result.current.editSelectedBrimEars({ kind: 'remove', index: 0 }))
  assert.deepEqual(setup.state.brimEars?.[setup.hostId], [])
  assert.equal(setup.histories, 2)
  assert.equal(setup.group.children.length, 0)
})

test('an edit with no selected object leaves state and history alone', () => {
  const setup = fixture(false)
  act(() => setup.result.current.editSelectedBrimEars({ kind: 'clear' }))
  assert.equal(setup.state.brimEars, undefined)
  assert.equal(setup.histories, 0)
})
