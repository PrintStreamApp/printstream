/**
 * Printability must be reachable from the object menu, not only from the sidebar Switch.
 *
 * The Switch is invisible to anyone working in the viewport, so a right-click could not skip a
 * model. BambuStudio carries a Printable item in its object menu for the same reason. A RENDER test
 * rather than a source scan, matching `editorPanels.libraryGating.test.tsx`: the label depends on
 * the clicked instance's state, and an inverted ternary is exactly the mistake worth catching.
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
const { EditorContextMenu } = await import('./EditorContextMenu')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

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

test('a printable object is offered the action that applies, not both', () => {
  renderObjectMenu({ printable: true })
  assert.ok(screen.queryByText('Skip printing'), 'a printable object offers to skip it')
  assert.equal(screen.queryByText('Set printable'), null, 'and never the action it is already in')
})

test('a skipped object is offered the other one', () => {
  renderObjectMenu({ printable: false })
  assert.ok(screen.queryByText('Set printable'))
  assert.equal(screen.queryByText('Skip printing'), null)
})

test('the item toggles the clicked object rather than setting a fixed value', () => {
  // The inverted-ternary catch: a menu that always sent `false` would pass the label tests above.
  const calls: boolean[] = []
  renderObjectMenu({ printable: true, onSetPrintable: (next: boolean) => calls.push(next) })
  fireEvent.click(screen.getByText('Skip printing'))
  assert.deepEqual(calls, [false])

  cleanup()
  const back: boolean[] = []
  renderObjectMenu({ printable: false, onSetPrintable: (next: boolean) => back.push(next) })
  fireEvent.click(screen.getByText('Set printable'))
  assert.deepEqual(back, [true])
})

test('an unresolvable state hides the item instead of guessing one', () => {
  renderObjectMenu({ printable: null })
  assert.equal(screen.queryByText('Skip printing'), null)
  assert.equal(screen.queryByText('Set printable'), null)
  // Control: the menu still rendered, so the assertions above are about this item and not about a
  // menu that failed to mount.
  assert.ok(screen.queryByText('Duplicate (linked)'))
})

test('a multi-selection keeps both explicit items', () => {
  // A mixed selection has no single state to label, so "Set printable" / "Skip printing" both show
  // and each says plainly what it will do to all of them.
  renderObjectMenu({ selectionCount: 3, printable: true })
  assert.ok(screen.queryByText('Set printable (3 objects)'))
  assert.ok(screen.queryByText('Skip printing (3 objects)'))
})
