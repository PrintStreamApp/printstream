import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useRef, useState } from 'react'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { RESTING_GIZMO_MODE, type GizmoMode } from './editorGeometry'
import { seedEmptyEditorState, type EditorInstance } from './lib/editorModel'
import type { PartRef } from './lib/selectionModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorContextMenuSession } = await import('./useEditorContextMenuSession')
const { useEditorSelectionSession } = await import('./useEditorSelectionSession')
const { useEditorSidebarSelectionActions } = await import('./useEditorSidebarSelectionActions')

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

function sidebarFixture() {
  const initial = seedEmptyEditorState()
  initial.plates[0]!.instances = [instance('a', 1), instance('b', 2), instance('c', 3), instance('d', 4)]

  return renderHook(() => {
    const [selectedKey, setSelectedKey] = useState<string | null>(null)
    const [gizmoPart, setGizmoPart] = useState<PartRef | null>(null)
    const [gizmoMode, setGizmoMode] = useState<GizmoMode>(RESTING_GIZMO_MODE)
    const stateRef = useRef(initial)
    const activePlateRef = useRef(initial.plates[0]!)
    const gizmoPartRef = useRef(gizmoPart)
    gizmoPartRef.current = gizmoPart
    const gizmoModeRef = useRef(gizmoMode)
    gizmoModeRef.current = gizmoMode

    const selection = useEditorSelectionSession({
      activePlateIndex: 1,
      state: initial,
      stateRef,
      selectedKey,
      setSelectedKey,
      setGizmoPart
    })
    const contextMenu = useEditorContextMenuSession({
      allSelectedKeysRef: selection.allSelectedKeysRef,
      selectExclusiveRef: selection.selectExclusiveRef
    })
    const actions = useEditorSidebarSelectionActions({
      activePlateRef,
      stateRef,
      selectedKeyRef: selection.selectedKeyRef,
      objectAnchorKeyRef: selection.objectAnchorKeyRef,
      partAnchorRef: selection.partAnchorRef,
      partSelectionRef: selection.partSelectionRef,
      gizmoPartRef,
      gizmoModeRef,
      allSelectedKeysRef: selection.allSelectedKeysRef,
      selectExclusive: selection.selectExclusive,
      toggleAdditiveSelection: selection.toggleAdditiveSelection,
      setSelectedKey,
      setExtraSelectedKeys: selection.setExtraSelectedKeys,
      setPartSelection: selection.setPartSelection,
      setGizmoPart,
      setGizmoMode,
      setContextMenu: contextMenu.setContextMenu
    })

    return { ...actions, ...selection, selectedKey, gizmoPart, gizmoMode, setGizmoMode, contextMenu: contextMenu.contextMenu }
  })
}

test('sidebar range keeps its anchor primary and object menus preserve selected members', () => {
  const view = sidebarFixture()
  act(() => view.result.current.handleSelect('a'))
  act(() => view.result.current.handleSelect('c', { range: true }))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['a', 'b', 'c'])

  act(() => view.result.current.handleObjectRowContextMenu('b', { x: 10, y: 20 }))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['a', 'b', 'c'])
  assert.deepEqual(view.result.current.contextMenu, { x: 10, y: 20, kind: 'object', key: 'b' })

  act(() => view.result.current.handleObjectRowContextMenu('d', { x: 30, y: 40 }))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['d'])
  act(() => view.result.current.handleSelect('b'))
  assert.deepEqual(view.result.current.allSelectedKeys(), ['b'])
})

test('part menus keep bulk members and added-part anchor alignment', () => {
  const view = sidebarFixture()
  const body = { kind: 'body' } as const
  const added = { kind: 'added', key: 'part-1' } as const
  act(() => view.result.current.setPartSelection({ objectId: 1, members: [body, added] }))
  act(() => view.result.current.handleAddedPartContextMenu(1, 'part-1', { x: 7, y: 9, align: 'end' }, 'a'))
  assert.deepEqual(view.result.current.contextMenu, {
    x: 7, y: 9, align: 'end', kind: 'parts', objectId: 1, members: [body, added]
  })

  act(() => view.result.current.setGizmoMode('rotate'))
  act(() => view.result.current.handlePartRowContextMenu(2, body, { x: 3, y: 4 }, 'b'))
  assert.deepEqual(view.result.current.contextMenu, {
    x: 3, y: 4, kind: 'parts', objectId: 2, members: [body]
  })
  assert.equal(view.result.current.selectedKey, 'b')
  assert.deepEqual(view.result.current.gizmoPart, { objectId: 2, member: body })
  assert.equal(view.result.current.gizmoMode, 'rotate')
})
