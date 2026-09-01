/**
 * The editor's library affordances must not render on a host that has no library.
 *
 * `EditorImportStore.supportsLibrarySource` existed for a while with no consumer, so the public
 * editor showed "From library…" / "Load from library…" and opened a workspace picker whose every
 * request 403s. These are RENDER tests rather than a source scan on purpose: the earlier scan-based
 * guard passed against an inverted ternary, which is precisely the mistake worth catching.
 *
 * The menus take the callback as OPTIONAL and hide the row when it is absent, so what is asserted
 * here is the row's presence. Every one of these is an `ActionMenuButton` now, where each route is
 * a peer row, so there is no primary half whose fall-through needs asserting separately.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'

const dom = installJsdomGlobals()

// The object menu anchors a Popper to a virtual element, which needs `DOMRect`; jsdom omits it.
if (typeof globalThis.DOMRect === 'undefined') {
  class TestDOMRect {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    get top() { return this.y }
    get left() { return this.x }
    get right() { return this.x + this.width }
    get bottom() { return this.y + this.height }
    toJSON() { return { ...this } }
    static fromRect(rect?: { x?: number; y?: number; width?: number; height?: number }) {
      return new TestDOMRect(rect?.x, rect?.y, rect?.width, rect?.height)
    }
  }
  globalThis.DOMRect = TestDOMRect as unknown as typeof globalThis.DOMRect
}

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { AddObjectMenu } = await import('./editorPanels')
const { AddPartSourceMenuItems } = await import('./contextMenuItems')
const { EditorContextMenu } = await import('./EditorContextMenu')
const { MenuList } = await import('@mui/joy')

/** `MenuItem` needs a menu context; the real context menus supply it, so the test does too. */
function renderPartSources(props: Record<string, unknown>) {
  return render(
    React.createElement(CssVarsProvider, null,
      React.createElement(MenuList, null,
        React.createElement(AddPartSourceMenuItems as never, {
          onPickPrimitive: () => undefined,
          onPickFile: () => undefined,
          ...props
        })))
  )
}

afterEach(() => cleanup())
after(() => dom.window.close())

function renderAddObjectMenu(props: Record<string, unknown>) {
  return render(
    React.createElement(CssVarsProvider, null,
      React.createElement(AddObjectMenu as never, {
        importing: false,
        onImportFile: () => undefined,
        onAddPrimitive: () => undefined,
        ...props
      }))
  )
}

/** Opens the Add menu so its rows are in the DOM. One click, whatever the host offers. */
function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'add object' }))
}

test('the Add menu offers the library when the host has one', () => {
  renderAddObjectMenu({ onAddFromLibrary: () => undefined })
  openMenu()
  assert.ok(screen.queryByText('From library…'), 'the library row should render')
})

test('the Add menu hides the library row on a host with none', () => {
  renderAddObjectMenu({})
  openMenu()
  assert.equal(screen.queryByText('From library…'), null)
  // The local-file row is what remains, so the control is still useful rather than empty.
  assert.ok(screen.queryByText('Upload local file…'))
})

test('the Add button performs no action of its own: one click opens the menu', () => {
  // It used to be a split button whose wide half opened the library picker, and silently uploaded
  // instead on a host without one, so the same control did two different things depending on where
  // it was mounted. Adding is a choice between alternatives, so every path is a row.
  const calls: string[] = []
  renderAddObjectMenu({
    onAddFromLibrary: () => calls.push('library'),
    onImportFile: () => calls.push('file')
  })
  fireEvent.click(screen.getByRole('button', { name: 'add object' }))
  assert.deepEqual(calls, [], 'the click itself adds nothing')
  assert.ok(screen.queryByText('From library…'), 'it opened the menu')
})

test('each Add menu row runs its own action', () => {
  const calls: string[] = []
  renderAddObjectMenu({
    onAddFromLibrary: () => calls.push('library'),
    onImportFile: () => calls.push('file')
  })
  openMenu()
  fireEvent.click(screen.getByText('From library…'))
  openMenu()
  fireEvent.click(screen.getByText('Upload local file…'))
  assert.deepEqual(calls, ['library', 'file'])
})

/**
 * The object context menu is the OTHER two entry points, and it decides for itself whether to pass
 * `onPickLibrary` down. Testing only the leaf list would miss an always-truthy inline arrow here,
 * the likeliest way this regresses, so the parent is rendered too.
 */
function renderObjectMenu(props: Record<string, unknown>) {
  const noop = () => undefined
  return render(
    React.createElement(CssVarsProvider, null,
      React.createElement(EditorContextMenu as never, {
        contextMenu: { x: 0, y: 0, key: 'object-1' },
        listboxRef: { current: null },
        onClose: noop,
        selectionCount: 1,
        onDuplicate: noop, onDuplicateIndependent: noop, onRename: noop, onSplitToObjects: noop,
        canAssemble: false, assembleCount: 1, onAssemble: noop,
        onReplaceFromFile: noop,
        canRepair: false, onRepairMesh: noop, isRepairMarked: false,
        onAddPartVolume: noop, onAddPartFromFile: noop,
        filamentOptions: [], onChangeMaterial: noop, onSetPrintable: noop,
        onCenterOnPlate: noop, onDropToBed: noop, onResetRotation: noop, onResetScale: noop,
        onMirror: noop, otherPlates: [], onMoveToPlate: noop, onDelete: noop,
        ...props
      }))
  )
}

test('the object menu offers Replace from library only when the host has one', () => {
  const withLibrary = renderObjectMenu({ onReplaceFromLibrary: () => undefined })
  assert.ok(screen.queryByText('Replace from library…'), 'control: the row renders when offered')
  withLibrary.unmount()

  renderObjectMenu({})
  assert.equal(screen.queryByText('Replace from library…'), null)
  assert.ok(screen.queryByText('Replace from file…'), 'the device row must survive')
})

test('the object menu row actually replaces from the library it was given', () => {
  // Presence is not enough: a row wired to the wrong handler renders identically.
  const calls: string[] = []
  renderObjectMenu({ onReplaceFromLibrary: (key: string) => calls.push(`library:${key}`) })
  fireEvent.click(screen.getByText('Replace from library…'))
  assert.deepEqual(calls, ['library:object-1'])
})

test('the add-part source list hides its library row on a host with none', () => {
  const withLibrary = renderPartSources({ onPickLibrary: () => undefined })
  assert.ok(screen.queryByText('Load from library…'), 'control: the row renders when offered')
  withLibrary.unmount()

  renderPartSources({})
  assert.equal(screen.queryByText('Load from library…'), null)
  assert.ok(screen.queryByText('Load from file…'), 'the device row must survive')
})
