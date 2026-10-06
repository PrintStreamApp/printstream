import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { seedEmptyEditorState, type EditorInstance } from './lib/editorModel'
import type { PartRef } from './lib/selectionModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorSelectionSession } = await import('./useEditorSelectionSession')

afterEach(cleanup)
after(() => dom.window.close())

function instance(key: string, objectId: number): EditorInstance {
  return {
    key,
    source: { kind: 'object' },
    objectId,
    instanceId: 0,
    name: key,
    position: new THREE.Vector3(),
    rotation: new THREE.Euler(),
    scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1,
    printable: true,
    parts: [],
    color: null
  }
}

function selectionFixture() {
  const initial = seedEmptyEditorState()
  initial.plates[0]!.instances = [instance('a', 1), instance('b', 2), instance('c', 3)]
  return renderHook(() => {
    const [state, setState] = useState(initial)
    const stateRef = useRef(state)
    stateRef.current = state
    const [selectedKey, setSelectedKey] = useState<string | null>('a')
    const [gizmoPart, setGizmoPart] = useState<PartRef | null>(null)
    const selection = useEditorSelectionSession({
      activePlateIndex: 1,
      state,
      stateRef,
      selectedKey,
      setSelectedKey,
      setGizmoPart
    })
    return { ...selection, selectedKey, gizmoPart, setGizmoPart, setState }
  })
}

test('object selection keeps additive keys ordered and clears part mode on a plain click', () => {
  const view = selectionFixture()
  act(() => view.result.current.toggleAdditiveSelection('b'))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['a', 'b'])
  assert.equal(view.result.current.objectAnchorKeyRef.current, 'b')

  act(() => {
    view.result.current.setPartSelection({ objectId: 1, members: [{ kind: 'body' }] })
    view.result.current.setGizmoPart({ objectId: 1, member: { kind: 'body' } })
  })
  act(() => view.result.current.selectExclusive('c'))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['c'])
  assert.equal(view.result.current.partSelection, null)
  assert.equal(view.result.current.gizmoPart, null)
  assert.equal(view.result.current.objectAnchorKeyRef.current, 'c')

  act(() => view.result.current.toggleAdditiveSelection('c'))
  assert.equal(view.result.current.selectedKey, null)
  assert.deepEqual(view.result.current.extraSelectedKeys, [])
})

test('scene edits prune selected keys no longer on the active plate', () => {
  const view = selectionFixture()
  act(() => view.result.current.toggleAdditiveSelection('b'))
  assert.deepEqual(view.result.current.extraSelectedKeys, ['b'])

  act(() => view.result.current.setState((state) => ({
    ...state,
    plates: state.plates.map((plate) => ({
      ...plate,
      instances: plate.instances.filter((entry) => entry.key !== 'b')
    }))
  })))
  assert.deepEqual(view.result.current.extraSelectedKeys, [])
})
