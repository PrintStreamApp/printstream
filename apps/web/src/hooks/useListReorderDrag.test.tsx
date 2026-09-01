/**
 * The drag state machine's PUBLISHED state, which is a performance contract as much as a data one.
 *
 * `drag` carries only the drag's SOURCE (which group, which item). Both are constant for the whole
 * gesture, so a drag re-renders its list twice however far the pointer travels. The moving part,
 * the insertion gap and the caret, is written straight onto the caret element. Putting the gap back
 * into React state is invisible in every small list and quietly costs one render of the editor's
 * object sidebar per row crossed, which is the most expensive component in the app.
 *
 * Also pins the rule that makes the object sidebar work at all: one item may span SEVERAL rows (an
 * object's linked copies and its part rows), and its extent is their union.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { renderHook, render, act, cleanup } = await import('@testing-library/react')
const { useListReorderDrag } = await import('./useListReorderDrag')

afterEach(() => cleanup())
after(() => dom.window.close())

const ROW_HEIGHT = 20

/** jsdom lays nothing out, so every element under test is told where it is. */
function stubRect(node: HTMLElement, top: number, height: number): void {
  node.getBoundingClientRect = () => ({
    top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({})
  }) as DOMRect
}

/** A node whose rect puts it at `[top, top + height)`, as a laid-out row would be. */
function rowAt(top: number, height = ROW_HEIGHT): HTMLElement {
  const node = dom.window.document.createElement('div')
  stubRect(node, top, height)
  // The hook skips rows that are not connected, so every stub joins the document.
  dom.window.document.body.appendChild(node)
  return node
}

/** The hook's API from inside the rendered list below, captured for the pointer driving. */
let dragApi: ReturnType<typeof useListReorderDrag> | null = null

function container(): HTMLElement {
  const node = dom.window.document.createElement('div')
  stubRect(node, 0, 400)
  dom.window.document.body.appendChild(node)
  return node
}

function pointer(type: string, clientY: number, extra: Record<string, unknown> = {}) {
  const event = new dom.window.Event(type, { bubbles: true }) as Event & Record<string, unknown>
  event.clientX = 0
  event.clientY = clientY
  event.pointerId = 1
  Object.assign(event, extra)
  return event
}

/** Mount the hook over one group of `rows` items, each `ROW_HEIGHT` tall, and drive a drag. */
function setup(rows: number) {
  const drops: Array<{ group: string; from: number; insertAt: number; before: number | null }> = []
  let renders = 0
  const view = renderHook(() => {
    renders += 1
    return useListReorderDrag({
      vertical: true,
      groups: [{ key: 'g', itemIndices: Array.from({ length: rows }, (_unused, index) => index) }],
      onDrop: (group, from, insertAt, before) => { drops.push({ group, from, insertAt, before }) }
    })
  })
  act(() => {
    view.result.current.setContainerElement(container())
    for (let index = 0; index < rows; index += 1) {
      view.result.current.setTileElement('g', index, rowAt(index * ROW_HEIGHT))
    }
  })
  const press = (index: number) => act(() => {
    view.result.current.handleTilePointerDown('g', index, {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: index * ROW_HEIGHT
    } as never)
  })
  const moveTo = (clientY: number) => act(() => { dom.window.dispatchEvent(pointer('pointermove', clientY)) })
  const release = () => act(() => { dom.window.dispatchEvent(pointer('pointerup', 0)) })
  return { view, drops, press, moveTo, release, rendersAfter: () => renders }
}

test('the published drag state does not change as the pointer crosses rows', () => {
  const { view, press, moveTo, release, rendersAfter } = setup(6)
  press(0)
  moveTo(ROW_HEIGHT * 2) // past the slop: the drag activates, which is the ONE state change
  const atStart = view.result.current.drag
  assert.deepEqual(atStart, { group: 'g', itemIndex: 0 })
  const rendersAtStart = rendersAfter()

  // Cross every remaining row. Each crossing moves the insertion gap, and the caret follows it
  // imperatively; none of it may reach React.
  for (let y = ROW_HEIGHT * 2; y < ROW_HEIGHT * 6; y += 4) moveTo(y)
  assert.equal(view.result.current.drag, atStart, 'the state object identity must survive the drag')
  assert.equal(rendersAfter(), rendersAtStart, 'crossing rows must not re-render the list')

  release()
  assert.equal(view.result.current.drag, null)
})

test('the drop reports the item it would land in front of, not just the gap', () => {
  const { drops, press, moveTo, release } = setup(4)
  press(0)
  moveTo(ROW_HEIGHT * 2 + 12) // past row 2's midpoint, so the gap is before row 3
  release()
  assert.deepEqual(drops, [{ group: 'g', from: 0, insertAt: 3, before: 3 }])
})

test('a drop past the last row reports no anchor, which every mover reads as "last"', () => {
  const { drops, press, moveTo, release } = setup(3)
  press(0)
  moveTo(ROW_HEIGHT * 3 + 5)
  release()
  assert.equal(drops[0]?.before, null)
})

test('a press with no movement is a click, not a drop', () => {
  const { view, drops, press, moveTo, release } = setup(3)
  press(1)
  moveTo(ROW_HEIGHT + 2) // under MOUSE_DRAG_SLOP_PX
  assert.equal(view.result.current.drag, null, 'no drag arms below the slop')
  release()
  assert.deepEqual(drops, [])
})

test('an item spanning several rows is measured as ONE extent', () => {
  // The object sidebar's shape: item 1 is three rows (an object plus its parts), item 0 is one.
  const drops: Array<number | null> = []
  const view = renderHook(() => useListReorderDrag({
    vertical: true,
    groups: [{ key: 'g', itemIndices: [0, 1] }],
    onDrop: (_group, _from, _insertAt, before) => { drops.push(before) }
  }))
  act(() => {
    view.result.current.setContainerElement(container())
    view.result.current.setTileElement('g', 0, rowAt(0))
    view.result.current.setTileElement('g', 1, rowAt(ROW_HEIGHT))
    view.result.current.setTileElement('g', 1, rowAt(ROW_HEIGHT * 2))
    view.result.current.setTileElement('g', 1, rowAt(ROW_HEIGHT * 3))
  })
  act(() => {
    view.result.current.handleTilePointerDown('g', 0, {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0
    } as never)
  })
  // Item 1 spans 20..80, so its midpoint is 50 and a pointer at 55 is PAST it: item 0 lands last.
  // The fixture is chosen to discriminate -- measuring only item 1's last row (60..80) puts its
  // midpoint at 70, and the same drop would answer "before item 1" instead.
  act(() => { dom.window.dispatchEvent(pointer('pointermove', 55)) })
  act(() => { dom.window.dispatchEvent(pointer('pointerup', 0)) })
  assert.deepEqual(drops, [null], 'past the middle of a tall item is past the whole item')
})

test('an item keeps all of its rows across a re-render, through React own ref lifecycle', () => {
  // The registration is a SET per item and a null drops the WHOLE set, because a ref callback
  // cannot say which element it is releasing. Consumers pass inline arrows, so React detaches and
  // re-attaches every row on every render. If it interleaved one row's detach with its sibling's
  // attach, an item spanning several rows would end up holding only its last one and the drop
  // boundary would move into the middle of it.
  //
  // Driven through a REAL render rather than by calling `setTileElement` in the right order by
  // hand, because the ordering is React's and that is the thing under test.
  const drops: Array<number | null> = []
  const tops = [0, ROW_HEIGHT, ROW_HEIGHT * 2, ROW_HEIGHT * 3]
  // Item 0 owns the first row, item 1 the last three (20..80, midpoint 50).
  const itemOfRow = [0, 1, 1, 1]

  function List({ tick }: { tick: number }) {
    const drag = useListReorderDrag({
      vertical: true,
      groups: [{ key: 'g', itemIndices: [0, 1] }],
      onDrop: (_group, _from, _insertAt, before) => { drops.push(before) }
    })
    dragApi = drag
    return React.createElement(
      'div',
      { ref: (element: HTMLElement | null) => { if (element) { stubRect(element, 0, 400) } drag.setContainerElement(element) } },
      tops.map((top, row) => React.createElement('div', {
        key: row,
        'data-tick': tick,
        // Inline arrow: a new callback identity every render, which is what forces the churn.
        ref: (element: HTMLElement | null) => {
          if (element) stubRect(element, top, ROW_HEIGHT)
          drag.setTileElement('g', itemOfRow[row]!, element)
        }
      }))
    )
  }

  const view = render(React.createElement(List, { tick: 0 }))
  view.rerender(React.createElement(List, { tick: 1 }))

  act(() => {
    dragApi!.handleTilePointerDown('g', 0, {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0
    } as never)
  })
  // Item 1 still spans 20..80 after the re-render, midpoint 50, so a pointer at 55 is past it and
  // item 0 lands last. Holding only its last row would put the midpoint at 70 and answer 1.
  act(() => { dom.window.dispatchEvent(pointer('pointermove', 55)) })
  act(() => { dom.window.dispatchEvent(pointer('pointerup', 0)) })
  assert.deepEqual(drops, [null], 'the multi-row item survived the re-render intact')
})

test('an item keeps all of its rows when only ONE of them re-renders', () => {
  // The sibling of the test above, and the case it cannot see. That one re-renders the whole list,
  // so every row re-attaches on the same commit and the "null drops the whole set" shortcut heals
  // itself. Here the rows are SEPARATELY MEMOIZED components, which is what the editor's object
  // sidebar is: each linked copy of an object is its own `ObjectListRow`, they all register under
  // that one object's key, and a prop that differs per copy (which one is selected) re-renders just
  // that copy. Its ref detaches -- dropping every row the item had -- and the siblings, bailed out
  // of their memo, never re-register.
  const drops: Array<number | null> = []
  const tops = [0, ROW_HEIGHT, ROW_HEIGHT * 2, ROW_HEIGHT * 3]
  // Item 0 owns the first row, item 1 the last three (20..80, midpoint 50).
  const itemOfRow = [0, 1, 1, 1]

  const renders: number[] = tops.map(() => 0)
  const Row = React.memo(function Row({ row, setTile }: {
    row: number
    selected: boolean
    setTile: (element: HTMLElement | null) => void
  }) {
    renders[row]! += 1
    return React.createElement('div', {
      ref: (element: HTMLElement | null) => {
        if (element) stubRect(element, tops[row]!, ROW_HEIGHT)
        setTile(element)
      }
    })
  })

  function List({ selectedRow }: { selectedRow: number }) {
    const drag = useListReorderDrag({
      vertical: true,
      groups: [{ key: 'g', itemIndices: [0, 1] }],
      onDrop: (_group, _from, _insertAt, before) => { drops.push(before) }
    })
    dragApi = drag
    // One STABLE callback per row, so a row re-renders ONLY when its own `selected` changes.
    // Building these inline would hand every Row a new prop each render, defeating the memo and
    // re-attaching every ref -- which is the very healing this test exists to remove.
    const { setTileElement } = drag
    const setTiles = React.useMemo(
      () => tops.map((_t, row) => (element: HTMLElement | null) =>
        setTileElement('g', itemOfRow[row]!, element)),
      [setTileElement]
    )
    return React.createElement(
      'div',
      { ref: (element: HTMLElement | null) => { if (element) { stubRect(element, 0, 400) } drag.setContainerElement(element) } },
      tops.map((_top, row) => React.createElement(Row, {
        key: row, row, selected: row === selectedRow, setTile: setTiles[row]!
      }))
    )
  }

  const view = render(React.createElement(List, { selectedRow: -1 }))
  // Select item 1's LAST row: only that component re-renders.
  view.rerender(React.createElement(List, { selectedRow: 3 }))
  // The control. Without this the test can pass for the wrong reason: if every Row re-rendered,
  // every ref would re-attach and the item would be whole again no matter what the hook does.
  assert.deepEqual(renders, [1, 1, 1, 2], 'the memo did not bail out; the fixture proves nothing')

  act(() => {
    dragApi!.handleTilePointerDown('g', 0, {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0
    } as never)
  })
  // Item 1 still spans 20..80, midpoint 50, so 55 is past it and item 0 lands last. Holding only
  // the re-rendered row (60..80) puts the midpoint at 70 and answers 1 -- the caret would be drawn
  // inside item 1's own body.
  act(() => { dom.window.dispatchEvent(pointer('pointermove', 55)) })
  act(() => { dom.window.dispatchEvent(pointer('pointerup', 0)) })
  assert.deepEqual(drops, [null], 'a memoized sibling row was dropped from the item extent')
})

test('the visible window is the SCROLLER, not the tall list registered as the container', () => {
  // The editor's object sidebar registers its `<List>` while the scroller is the `<Sheet>` around
  // it. The List's rect is the full CONTENT box, so measuring "released outside" against it meant a
  // pointer dragged out onto the 3D viewport still counted as inside and the drop committed.
  const drops: number[] = []
  const scroller = dom.window.document.createElement('div')
  scroller.style.overflowY = 'auto'
  stubRect(scroller, 0, 100) // the visible window
  dom.window.document.body.appendChild(scroller)
  const list = dom.window.document.createElement('div')
  stubRect(list, -400, 1000) // a tall list, scrolled: its box runs far above and below the window
  scroller.appendChild(list)

  const view = renderHook(() => useListReorderDrag({
    vertical: true,
    groups: [{ key: 'g', itemIndices: [0, 1] }],
    onDrop: (_group, from) => { drops.push(from) }
  }))
  act(() => {
    view.result.current.setContainerElement(list)
    view.result.current.setTileElement('g', 0, rowAt(0))
    view.result.current.setTileElement('g', 1, rowAt(ROW_HEIGHT))
  })
  act(() => {
    view.result.current.handleTilePointerDown('g', 0, {
      button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0
    } as never)
  })
  act(() => { dom.window.dispatchEvent(pointer('pointermove', 40)) }) // activate the drag
  // 300px below the visible window but still inside the List's content box. Against the List this
  // reads as inside and the drop commits; against the window it is the abort gesture.
  act(() => { dom.window.dispatchEvent(pointer('pointermove', 300)) })
  act(() => { dom.window.dispatchEvent(pointer('pointerup', 300)) })
  assert.deepEqual(drops, [], 'releasing outside the visible list cancels the drop')
})
