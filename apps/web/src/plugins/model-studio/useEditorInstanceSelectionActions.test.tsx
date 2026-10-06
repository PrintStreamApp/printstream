import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { useState } from 'react'
import * as THREE from 'three'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { INHERITED_PLATE_SETTINGS, type EditorInstance, type EditorPlate } from './lib/editorModel'
import type { PartRef, PartSelection } from './lib/selectionModel'

const dom = installJsdomGlobals()
const { act, cleanup, renderHook } = await import('@testing-library/react')
const { useEditorInstanceSelectionActions } = await import('./useEditorInstanceSelectionActions')

afterEach(cleanup)
after(() => dom.window.close())

function instance(key: string): EditorInstance {
  return {
    key, source: { kind: 'object' }, objectId: 1, instanceId: 0, name: key,
    position: new THREE.Vector3(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1),
    filamentId: 1, printable: true, parts: [], color: null
  }
}

function plate(instances: EditorInstance[]): EditorPlate {
  return {
    index: 1, plateId: 1, sourcePlateIndex: null, name: null, ...INHERITED_PLATE_SETTINGS,
    bed: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100, excludeAreas: [] },
    instances, primeTower: null
  }
}

function selectionFixture() {
  const activePlateRef = { current: plate([instance('a'), instance('b'), instance('c')]) }
  const targetPlate = plate([])
  const platesRef = {
    current: [
      activePlateRef.current,
      {
        ...targetPlate, index: 2, plateId: 2,
        bed: { ...targetPlate.bed, maxX: 200, maxY: 200 }
      }
    ]
  }
  const objectAnchorKeyRef = { current: null as string | null }
  const updates: string[] = []
  const view = renderHook(() => {
    const [selectedKey, setSelectedKey] = useState<string | null>('a')
    const [extraSelectedKeys, setExtraSelectedKeys] = useState<readonly string[]>(['b'])
    const [partSelection, setPartSelection] = useState<PartSelection | null>({ objectId: 1, members: [{ kind: 'body' }] })
    const [gizmoPart, setGizmoPart] = useState<PartRef | null>({ objectId: 1, member: { kind: 'body' } })
    const actions = useEditorInstanceSelectionActions({
      activePlateIndex: 1,
      activePlateRef,
      selectionFor: () => ['a', 'b'],
      updatePlates: (update, kind) => {
        updates.push(kind ?? 'structure')
        platesRef.current = update(platesRef.current)
        activePlateRef.current = platesRef.current[0]!
      },
      selectExclusive: (key) => { setSelectedKey(key); setExtraSelectedKeys([]) },
      setSelectedKey,
      setExtraSelectedKeys,
      setPartSelection,
      setGizmoPart,
      objectAnchorKeyRef
    })
    return { ...actions, selectedKey, extraSelectedKeys, partSelection, gizmoPart }
  })
  return { ...view, activePlateRef, platesRef, objectAnchorKeyRef, updates }
}

test('deleting a selected object removes the whole selection and prunes selected keys', () => {
  const fixture = selectionFixture()
  act(() => fixture.result.current.handleDelete('a'))
  assert.deepEqual(fixture.activePlateRef.current.instances.map((entry) => entry.key), ['c'])
  assert.equal(fixture.result.current.selectedKey, null)
  assert.deepEqual(fixture.result.current.extraSelectedKeys, [])
  assert.deepEqual(fixture.updates, ['structure'])
})

test('select all switches to object mode; paste spreads copies and selects the last', () => {
  const fixture = selectionFixture()
  act(() => fixture.result.current.handleSelectAllObjects())
  assert.equal(fixture.result.current.selectedKey, 'a')
  assert.deepEqual(fixture.result.current.extraSelectedKeys, ['b', 'c'])
  assert.equal(fixture.result.current.partSelection, null)
  assert.equal(fixture.result.current.gizmoPart, null)
  assert.equal(fixture.objectAnchorKeyRef.current, 'a')

  act(() => fixture.result.current.handlePasteInstances([instance('copy-1'), instance('copy-2')]))
  const placed = fixture.activePlateRef.current.instances.slice(-2)
  assert.deepEqual(placed.map((entry) => entry.key), ['copy-1', 'copy-2'])
  assert.notDeepEqual(placed[0]!.position.toArray(), placed[1]!.position.toArray())
  assert.equal(fixture.result.current.selectedKey, 'copy-2')
  assert.deepEqual(fixture.result.current.extraSelectedKeys, [])
  assert.deepEqual(fixture.updates, ['structure'])
})

test('moving a selected set to another plate places both and clears their old selection', () => {
  const fixture = selectionFixture()
  const sourcePositions = fixture.activePlateRef.current.instances.slice(0, 2)
    .map((entry) => entry.position.toArray())

  act(() => fixture.result.current.handleMoveToPlate('a', 2))

  assert.deepEqual(fixture.platesRef.current[0]!.instances.map((entry) => entry.key), ['c'])
  const moved = fixture.platesRef.current[1]!.instances
  assert.deepEqual(moved.map((entry) => entry.key), ['a', 'b'])
  assert.notDeepEqual(moved[0]!.position.toArray(), moved[1]!.position.toArray())
  assert.deepEqual(sourcePositions, [[0, 0, 0], [0, 0, 0]])
  assert.equal(fixture.result.current.selectedKey, null)
  assert.deepEqual(fixture.result.current.extraSelectedKeys, [])
  assert.deepEqual(fixture.updates, ['structure'])
})

test('bulk Printable sets selected objects while row toggle affects only one copy', () => {
  const fixture = selectionFixture()

  act(() => fixture.result.current.handleSetPrintableSelection(['a', 'b'], false))
  assert.deepEqual(fixture.activePlateRef.current.instances.map((entry) => entry.printable), [false, false, true])

  act(() => fixture.result.current.handleTogglePrintable('a'))
  assert.deepEqual(fixture.activePlateRef.current.instances.map((entry) => entry.printable), [true, false, true])
  assert.deepEqual(fixture.updates, ['visibility', 'visibility'])
})
