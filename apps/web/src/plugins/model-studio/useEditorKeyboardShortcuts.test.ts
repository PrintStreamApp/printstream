import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

installJsdomGlobals()

const { renderHook } = await import('@testing-library/react')
const { useEditorKeyboardShortcuts } = await import('./useEditorKeyboardShortcuts')
const { seedEmptyEditorState, instanceFromStagedImport } = await import('./lib/editorModel')

function ref<T>(value: T) {
  return { current: value }
}

function makeInput(overrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[]> = {}
  const spy = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args) }
  const plate = seedEmptyEditorState().plates[0]!
  const object = instanceFromStagedImport({
    importId: 'imp-1', name: 'A.stl', format: 'stl', triangleCount: 1,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    parts: [{ name: 'A.stl', triangleCount: 1, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, subtype: null }]
  })
  object.source = { kind: 'object' }
  object.objectId = 1
  plate.instances.push(object)
  const input = {
    enabledRef: ref(true),
    selectedKeyRef: ref<string | null>(object.key),
    activePlateRef: ref(plate),
    selectionKeysRef: ref([object.key]),
    onDuplicate: spy('duplicate'),
    onDelete: spy('delete'),
    onSelectAll: spy('selectAll'),
    onClearSelection: spy('clear'),
    onPasteInstances: spy('paste'),
    undoRef: ref(spy('undo')),
    redoRef: ref(spy('redo')),
    setGizmoModeRef: ref(spy('gizmo')),
    ...overrides
  }
  return { input, calls }
}

function press(key: string, opts: KeyboardEventInit = {}, target: EventTarget = window) {
  // jsdom exposes KeyboardEvent on `window`, not as a bare global.
  const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  target.dispatchEvent(event)
  return event
}

test('Delete deletes the selection; Ctrl+Z/Shift undo and redo', () => {
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('Delete')
  assert.equal(calls.delete?.length, 1)
  press('z', { ctrlKey: true })
  press('z', { ctrlKey: true, shiftKey: true })
  assert.equal(calls.undo?.length, 1)
  assert.equal(calls.redo?.length, 1)
})

test('cut then paste works even after the selection is gone (in-memory clipboard)', () => {
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('x', { ctrlKey: true })
  assert.equal(calls.delete?.length, 1, 'cut deletes')
  // Selection is now empty, but the clipboard still holds the cut object.
  input.selectedKeyRef.current = null
  input.selectionKeysRef.current = []
  press('v', { ctrlKey: true })
  press('v', { ctrlKey: true })
  assert.equal(calls.paste?.length, 2, 'paste repeats from the clipboard')
  // Each paste produced a fresh instance with its own key.
  const first = (calls.paste![0] as unknown[])[0] as Array<{ key: string }>
  const second = (calls.paste![1] as unknown[])[0] as Array<{ key: string }>
  assert.notEqual(first[0]!.key, second[0]!.key)
})

test('shortcuts do not fire while typing in a field', () => {
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  const field = document.createElement('input')
  document.body.appendChild(field)
  press('Delete', {}, field)
  press('a', { ctrlKey: true }, field)
  assert.equal(calls.delete, undefined)
  assert.equal(calls.selectAll, undefined)
})

test('shortcuts are inert when disabled', () => {
  const { input, calls } = makeInput({ enabledRef: ref(false) })
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('Delete')
  assert.equal(calls.delete, undefined)
})

test('M/R/S switch the gizmo only with a selection', () => {
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('r')
  assert.deepEqual(calls.gizmo?.at(-1), ['rotate'])
  input.selectedKeyRef.current = null
  press('s')
  assert.equal(calls.gizmo?.length, 1, 'no gizmo switch without a selection')
})
