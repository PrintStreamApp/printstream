import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { GizmoMode } from './editorGeometry'

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
    partSelectedRef: ref(false),
    activePlateRef: ref(plate),
    selectionKeysRef: ref([object.key]),
    onDuplicate: spy('duplicate'),
    onCloneWithCount: spy('cloneWithCount'),
    onDelete: spy('delete'),
    onSelectAll: spy('selectAll'),
    onPasteInstances: spy('paste'),
    undoRef: ref(spy('undo')),
    redoRef: ref(spy('redo')),
    setGizmoModeRef: ref(spy('gizmo')),
    gizmoModeRef: ref<GizmoMode>('select'),
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

test('Delete fires over a PART selection, which nulls the object key', () => {
  // The bulk part path clears `selectedKey` on purpose (object and part selection are different
  // modes and never coexist), so gating Delete on the object key alone made the key do nothing over
  // a visible multi-part selection: the handler was reached only when an object was also selected.
  const { input, calls } = makeInput({
    selectedKeyRef: ref<string | null>(null),
    partSelectedRef: ref(true)
  })
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('Delete')
  assert.equal(calls.delete?.length, 1, 'Delete did nothing over a part selection')
  // The key is null: only the caller knows which parts are selected, and it reads them itself.
  assert.deepEqual(calls.delete?.[0], [null])
})

test('with nothing selected at all, Delete stays inert', () => {
  const { input, calls } = makeInput({
    selectedKeyRef: ref<string | null>(null),
    partSelectedRef: ref(false)
  })
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('Delete')
  assert.equal(calls.delete, undefined)
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

test('Ctrl+K clones with a count, and only with a selection', () => {
  // BambuStudio's own binding (`KBShortcutsDialog.cpp`: ctrl + "K"). Distinct from Ctrl+D, which
  // makes exactly one LINKED copy: Studio's clone prompts for a number and makes independent ones.
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  const event = press('k', { ctrlKey: true })
  assert.equal(calls.cloneWithCount?.length, 1)
  assert.equal(calls.duplicate, undefined, 'Ctrl+K must not also fire the plain duplicate')
  assert.equal(event.defaultPrevented, true, 'the browser default was left to fire')

  input.selectedKeyRef.current = null
  press('k', { ctrlKey: true })
  assert.equal(calls.cloneWithCount?.length, 1, 'cloned with nothing selected')
})

test('a bare K is left to the viewport rather than cloning', () => {
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))
  press('k')
  assert.equal(calls.cloneWithCount, undefined)
})

test('M/R/S toggle back to resting, matching the rail and Studio', () => {
  // Studio's `handle_shortcut` ends in `open_gizmo` (`GLGizmosManager.cpp:494`) -- the same call
  // the toolbar makes -- and `open_gizmo` flips to `Undefined` when the requested gizmo is already
  // current (`:366`). Written as plain sets, the keyboard was the one affordance that could never
  // reach the resting mode.
  const { input, calls } = makeInput()
  renderHook(() => useEditorKeyboardShortcuts(input))

  press('m')
  assert.deepEqual(calls.gizmo?.[0], ['translate'], 'from resting, M picks Move')

  input.gizmoModeRef.current = 'translate'
  press('m')
  assert.deepEqual(calls.gizmo?.[1], ['select'], 'M again returns to resting')

  // A DIFFERENT tool key still switches rather than toggling.
  press('r')
  assert.deepEqual(calls.gizmo?.[2], ['rotate'])
})

test('Escape is NOT handled here, because it never gets here', () => {
  // The editor renders inside a Joy `Modal`, whose keydown handler calls `stopPropagation()` on
  // Escape ("Swallow the event, in case someone is listening for the escape key on the body" --
  // `@mui/base/unstable_useModal`), so it never bubbles to this window listener. A two-stage Escape
  // WAS written here and shipped green, because a test that mounts this hook with no Modal around it
  // proves only that the code runs, not that the key arrives. Confirmed in a real browser: pressing
  // Escape in the editor fired a window CAPTURE probe and never the bubble one, left the tool on
  // Move, and raised the editor's own close prompt.
  // The behaviour now lives in `EditorView`'s `Modal.onClose`, over `editorEscapeAction`.
  const { input, calls } = makeInput({ gizmoModeRef: ref<GizmoMode>('translate') })
  renderHook(() => useEditorKeyboardShortcuts(input))

  press('Escape')
  assert.equal(calls.gizmo, undefined, 'Escape must not be claimed here; the Modal owns it')
})
