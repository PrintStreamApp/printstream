import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import type { SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { partSlotKey, seedEmptyEditorState, type EditorInstance } from './lib/editorModel'

const dom = installJsdomGlobals()
const { cleanup, renderHook } = await import('@testing-library/react')
const { useEditorObjectListProcessSettings } = await import('./useEditorObjectListProcessSettings')

afterEach(cleanup)
after(() => dom.window.close())

test('sidebar process controls include unsaved ids and refresh badges only for relevant state', () => {
  const initialState = seedEmptyEditorState()
  initialState.objectClones = { [-300]: 17 }
  initialState.partProcessOverrides = { [partSlotKey(17, 2)]: { layer_height: '0.16' } }
  initialState.plates[0]!.instances = [{
    key: 'new-import',
    source: { kind: 'import', importId: 'staged', meshUrl: '/mesh', replacedObjectId: -200 }
  } as EditorInstance]

  const perObject = {
    value: { '17': { wall_loops: '3' } }
  } as unknown as NonNullable<SliceSettingsController['perObjectSettings']>
  const plateObjects = [{ id: 17, name: 'Body' }]
  const stateRef = { current: initialState }
  let editedObject: unknown = null
  let editedPart: unknown = null
  const setEditingObject = (value: unknown) => { editedObject = value }
  const setEditingPart = (value: unknown) => { editedPart = value }

  const view = renderHook(
    ({ state }) => useEditorObjectListProcessSettings({
      perObject,
      plateObjects,
      activePlate: state.plates[0] ?? null,
      state,
      stateRef,
      setEditingObject,
      setEditingPart
    }),
    { initialProps: { state: initialState } }
  )

  const first = view.result.current
  assert.deepEqual([...first!.sliceObjectIds].sort((a, b) => a - b), [-300, -200, 17])
  assert.equal(first!.overrideCountFor(17), 1)
  assert.equal(first!.partOverrideCountFor!(17, 2), 1)
  first!.onEditObject(17, 'Body')
  first!.onEditPart!(17, 2, 'Feature')
  assert.deepEqual(editedObject, { ids: [17], name: 'Body' })
  assert.deepEqual(editedPart, {
    objectId: 17,
    members: [{ kind: 'baked', partIndex: 2 }],
    name: 'Feature'
  })

  const unrelatedState = { ...initialState, plates: [...initialState.plates] }
  stateRef.current = unrelatedState
  view.rerender({ state: unrelatedState })
  assert.equal(view.result.current, first)

  const updatedState = {
    ...unrelatedState,
    partProcessOverrides: { [partSlotKey(17, 2)]: { layer_height: '0.16', wall_loops: '4' } }
  }
  stateRef.current = updatedState
  view.rerender({ state: updatedState })
  assert.notEqual(view.result.current, first)
  assert.equal(view.result.current!.partOverrideCountFor!(17, 2), 2)
})
