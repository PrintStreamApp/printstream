/**
 * Pointer-event drag-reorder state machine for a tile/row list (the editor's plate strip, the
 * slice panel's materials list). Owns pointer capture-free tracking on `window`, drag activation, the
 * insertion-gap target, edge auto-scroll of the strip, and click suppression after a drop; the
 * gap/caret geometry itself is the pure `lib/listReorder.ts`.
 *
 * Pointer events (not HTML5 drag-and-drop) deliberately: native `draggable` never fires on touch,
 * which made plate reordering desktop-only on a fully-supported mobile surface. One state machine
 * covers both inputs with their platform-standard activation:
 * - mouse/pen: drag arms on press and activates after a small movement slop, so plain clicks
 *   still select the plate;
 * - touch: a hold (`TOUCH_HOLD_MS`) activates the drag; moving beyond the slop before the hold
 *   elapses is a scroll and aborts the pending drag. Once active, a non-passive `touchmove`
 *   blocker prevents the page/strip from scrolling under the drag, this must be a raw listener
 *   because pointer events cannot cancel native scrolling. (Touch long-press previously opened
 *   the tile's context menu; that menu stays reachable via the tile's kebab button.)
 *
 * The drop lands in an insertion GAP between tiles (0..N), never on a tile: see
 * `lib/listReorder.ts` for why. A pointer released outside the strip (plus a margin)
 * cancels the drag, which is also the escape hatch for a drag the user regrets.
 *
 * Rows are GROUPED, and a drag can never leave the group it started in. A flat list passes one
 * group and never thinks about it again; the editor's object sidebar passes one group for the
 * objects plus one per object for its parts, which is what enforces BambuStudio's rule that a
 * volume never moves out of its object (`ObjectList::can_drop`). The alternative, one hook per
 * list, is not available: an object's parts render inline for every multi-part object, so their
 * count varies per render and hooks cannot.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listInsertionCaretCenter, listInsertionGap, type ListTileExtent } from '../lib/listReorder'

/** Hold time before a touch press becomes a drag (matches common mobile reorder affordances). */
const TOUCH_HOLD_MS = 280
/** Mouse/pen movement that turns a press into a drag rather than a click. */
const MOUSE_DRAG_SLOP_PX = 5
/** Touch movement that, before the hold elapses, means "scroll" and aborts the pending drag. */
const TOUCH_SCROLL_SLOP_PX = 10
/** How far outside the strip the pointer may wander before the drop target clears (drop cancels). */
const OUTSIDE_CANCEL_MARGIN_PX = 48
/** Distance from a strip edge within which dragging auto-scrolls the strip. */
const EDGE_SCROLL_ZONE_PX = 28
/** Auto-scroll speed, px per animation frame. */
const EDGE_SCROLL_STEP_PX = 9

/** One reorderable list: its identity, and its item indices in the order they are rendered. */
export interface ListReorderGroup {
  key: string
  itemIndices: readonly number[]
}

/**
 * The live drag, as React state.
 *
 * DELIBERATELY only the SOURCE: which group, and which item is being dragged. Both are constant for
 * the whole gesture, so a drag re-renders its list exactly twice (start and end) however far the
 * pointer travels. The moving part -- the insertion gap and the caret position -- is published
 * imperatively through `setCaretElement` instead, because it changes every time the pointer crosses
 * a row: with it in state, dragging down a 176-row object sidebar re-rendered the single most
 * expensive component in the editor once per row crossed.
 */
export interface ListReorderDragState {
  /** The group the drag started in. Nothing outside it may respond to the drag. */
  group: string
  /** Live index of the item being dragged, within its group. */
  itemIndex: number
}

interface DragSession {
  pointerId: number
  pointerType: string
  group: string
  itemIndex: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  active: boolean
  /** Mirror of the published insertAt, readable synchronously at drop time. */
  insertAt: number | null
  /** The item the drop would land in front of (null = last), resolved from the gap each frame. */
  beforeIndex: number | null
  holdTimer: ReturnType<typeof setTimeout> | null
  rafId: number | null
  detach: () => void
}

/** Address a tile: its group and index, joined on a separator no group key can contain. */
const tileKey = (group: string, itemIndex: number): string => `${group}\u0000${itemIndex}`

/**
 * The union of a group item's rows along the drag axis, or null when none are on screen.
 *
 * An item is not always ONE row. In the editor's object sidebar an object is a run of rows: its
 * linked copies, plus its part rows. The caret is drawn on the boundary between items, so measuring
 * only the first row of each would put the gap for a three-copy object in the middle of its own
 * body. Registering every row under the same item index and unioning them is also what removes the
 * caller's "only register the leading row" bookkeeping, which silently depended on render order.
 */
function unionExtent(elements: Set<HTMLElement>, vertical: boolean): ListTileExtent | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const element of elements) {
    // Also where the registry is PRUNED. A released row is dropped here, on sight of its detached
    // node, rather than when React hands its ref a null -- see `setTileElement` for why that is the
    // only safe moment. Measuring is the only reader, so nothing can observe a stale entry.
    if (!element.isConnected) { elements.delete(element); continue }
    const rect = element.getBoundingClientRect()
    // A `display: none` row is still "connected" and reports an all-zero rect, which would drag the
    // item's start to the top of the VIEWPORT and put it ahead of every other item in the group.
    if (rect.width === 0 && rect.height === 0) continue
    start = Math.min(start, vertical ? rect.top : rect.left)
    end = Math.max(end, vertical ? rect.bottom : rect.right)
  }
  return start <= end ? { start, end } : null
}

export function useListReorderDrag(options: {
  vertical: boolean
  /** The reorderable lists, each with its item indices in render order. A drag stays in one. */
  groups: readonly ListReorderGroup[]
  /**
   * A completed drop. `beforeIndex` is the item the moved one must land in front of, resolved from
   * the insertion gap, or null for last -- callers reorder by identity, not by counting.
   */
  onDrop: (group: string, fromIndex: number, insertAt: number, beforeIndex: number | null) => void
}): {
  drag: ListReorderDragState | null
  setContainerElement: (element: HTMLElement | null) => void
  /** Register one of an item's rows. An item may span several; they are measured as one extent. */
  setTileElement: (group: string, itemIndex: number, element: HTMLElement | null) => void
  handleTilePointerDown: (group: string, itemIndex: number, event: React.PointerEvent) => void
  /**
   * Register the insertion caret element (see `components/ListReorderCaret.tsx`). Positioned by the
   * drag loop rather than by a render, so tracking the pointer costs no React work.
   */
  setCaretElement: (element: HTMLElement | null) => void
  /** True exactly once after a drag completed: swallow the click the drop synthesizes. */
  shouldSuppressClick: () => boolean
} {
  const [drag, setDrag] = useState<ListReorderDragState | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  const caretRef = useRef<HTMLElement | null>(null)
  // A SET per item: an item can span several rows (an object's linked copies and its part rows).
  const tilesRef = useRef(new Map<string, Set<HTMLElement>>())
  const sessionRef = useRef<DragSession | null>(null)
  const suppressClickRef = useRef(false)
  // Latest options for the window listeners, which outlive any single render.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const setContainerElement = useCallback((element: HTMLElement | null) => {
    containerRef.current = element
  }, [])

  /**
   * The nearest ancestor that actually scrolls, or the container itself.
   *
   * The element a caller registers is the one the caret is positioned INSIDE, which is not always
   * the one that scrolls: the editor's object sidebar registers its `<List>` while the scroller is
   * the `<Sheet>` wrapping it. Reading `scrollTop` off the List (always 0) and writing to it made
   * edge auto-scroll a no-op, and its rect is the full CONTENT box, so a pointer dragged out onto
   * the viewport still counted as inside and the drop committed instead of cancelling.
   */
  const scrollParent = useCallback((element: HTMLElement): HTMLElement => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const overflow = node.ownerDocument.defaultView?.getComputedStyle(node).overflowY ?? ''
      if (overflow === 'auto' || overflow === 'scroll') return node
    }
    return element
  }, [])

  const setCaretElement = useCallback((element: HTMLElement | null) => {
    caretRef.current = element
    if (element) element.style.display = 'none'
  }, [])

  /** Move the caret to a gap, or hide it. The one place the caret's position is decided. */
  const paintCaret = useCallback((offset: number | null) => {
    const caret = caretRef.current
    if (!caret) return
    if (offset === null) { caret.style.display = 'none'; return }
    caret.style.display = 'block'
    // ONE coordinate, in the container's content space. The caret centres itself on it with a CSS
    // transform, so nothing here measures the element and no frame forces a layout flush.
    //
    // The OTHER axis is cleared rather than left alone: an inline style always beats the component's
    // class, and the plate strip flips orientation responsively while keeping the same DOM node, so
    // a `top` left over from the vertical rail survived into the horizontal strip and stretched the
    // caret from that stale offset down to the class's `bottom`.
    if (optionsRef.current.vertical) { caret.style.top = `${offset}px`; caret.style.left = '' }
    else { caret.style.left = `${offset}px`; caret.style.top = '' }
  }, [])

  const setTileElement = useCallback((group: string, itemIndex: number, element: HTMLElement | null) => {
    // A null is IGNORED, and that is load-bearing. React calls a ref callback with null before
    // re-attaching, and a callback ref cannot say which element it is releasing, so the only thing
    // a null could do here is drop the item's whole row set. That used to be harmless because every
    // row of an item re-rendered together and re-registered on the same commit -- but an item's rows
    // can be SEPARATELY MEMOIZED components (each linked copy of an object is its own row, and they
    // all register under that object's key), so a commit that re-renders one of them detached the
    // ref, cleared the set, and left the siblings bailed out of their memo and never re-registering.
    // The item then measured a fraction of itself and the drop boundary moved into its own body.
    //
    // Ignoring the null is safe because a re-render reuses the same DOM node, so re-adding is a
    // no-op on the Set; only a genuine unmount leaves an entry behind, and `unionExtent` drops those
    // when it sees a detached node. (React 19's ref cleanup functions would say which element is
    // going; on 18 there is no such signal.)
    if (!element) return
    const key = tileKey(group, itemIndex)
    let rows = tilesRef.current.get(key)
    if (!rows) { rows = new Set(); tilesRef.current.set(key, rows) }
    rows.add(element)
  }, [])

  /**
   * Tile extents along the strip axis in viewport coords + the container rect, or null.
   *
   * Measures ONLY the dragged tile's own group, which is what confines the drop: gaps are counted
   * within that list, so a pointer over another group's rows resolves to this group's nearest gap
   * rather than to a position in a list the item may not enter.
   */
  const measure = useCallback((group: string) => {
    const container = containerRef.current
    if (!container) return null
    const { vertical, groups } = optionsRef.current
    const itemIndices = groups.find((entry) => entry.key === group)?.itemIndices ?? []
    const tiles: ListTileExtent[] = []
    const contentOffsets: ListTileExtent[] = []
    const containerRect = container.getBoundingClientRect()
    // Coordinates come from the CONTAINER (the caret's offset parent); visibility comes from the
    // element that scrolls. They are the same for a self-scrolling strip.
    const scroller = scrollParent(container)
    const scrollerRect = scroller.getBoundingClientRect()
    const scroll = vertical ? container.scrollTop : container.scrollLeft
    const containerStart = vertical ? containerRect.top : containerRect.left
    // Only the items that are actually on screen contribute a gap, so `insertAt` indexes THIS
    // array, not `itemIndices` -- which is why the anchor is read from here at drop time.
    const measuredIndices: number[] = []
    for (const itemIndex of itemIndices) {
      const rows = tilesRef.current.get(tileKey(group, itemIndex))
      const extent = rows ? unionExtent(rows, vertical) : null
      if (!extent) continue
      measuredIndices.push(itemIndex)
      tiles.push(extent)
      contentOffsets.push({
        start: extent.start - containerStart + scroll,
        end: extent.end - containerStart + scroll
      })
    }
    // The visible window is the INTERSECTION: a tall list clipped by its scroller, or a short list
    // sitting inside a much larger one. Either way this is the box "released outside" means.
    const visibleRect = {
      top: Math.max(containerRect.top, scrollerRect.top),
      bottom: Math.min(containerRect.bottom, scrollerRect.bottom),
      left: Math.max(containerRect.left, scrollerRect.left),
      right: Math.min(containerRect.right, scrollerRect.right)
    }
    return { container, scroller, visibleRect, tiles, contentOffsets, measuredIndices }
  }, [scrollParent])

  /** Recompute the insertion target from the last pointer position and publish it. */
  const updateTarget = useCallback(() => {
    const session = sessionRef.current
    if (!session?.active) return
    const measured = measure(session.group)
    if (!measured) return
    const { visibleRect, tiles, contentOffsets, measuredIndices } = measured
    const { vertical } = optionsRef.current
    const outside =
      session.lastX < visibleRect.left - OUTSIDE_CANCEL_MARGIN_PX
      || session.lastX > visibleRect.right + OUTSIDE_CANCEL_MARGIN_PX
      || session.lastY < visibleRect.top - OUTSIDE_CANCEL_MARGIN_PX
      || session.lastY > visibleRect.bottom + OUTSIDE_CANCEL_MARGIN_PX
    const pointer = vertical ? session.lastY : session.lastX
    const insertAt = outside ? null : listInsertionGap(tiles, pointer)
    const caretOffset = insertAt === null ? null : listInsertionCaretCenter(contentOffsets, insertAt)
    session.insertAt = insertAt
    // Resolved here, where the measured list is in hand: a gap past the last item is "last", and a
    // gap ON the dragged item resolves to the item itself, which every mover treats as a no-op.
    session.beforeIndex = insertAt === null ? null : measuredIndices[insertAt] ?? null
    // No setState: the source has not changed, only where the drop would land.
    paintCaret(caretOffset)
  }, [measure, paintCaret])

  /** Scroll the strip when the drag hovers near either end, so off-screen gaps are reachable. */
  const edgeScroll = useCallback(() => {
    const session = sessionRef.current
    const container = containerRef.current
    if (!session?.active || !container) return
    // The element that scrolls, which is not always the one the caret sits in. See `scrollParent`.
    const scroller = scrollParent(container)
    const rect = scroller.getBoundingClientRect()
    const { vertical } = optionsRef.current
    const pointer = vertical ? session.lastY : session.lastX
    const start = vertical ? rect.top : rect.left
    const end = vertical ? rect.bottom : rect.right
    let delta = 0
    if (pointer < start + EDGE_SCROLL_ZONE_PX) delta = -EDGE_SCROLL_STEP_PX
    else if (pointer > end - EDGE_SCROLL_ZONE_PX) delta = EDGE_SCROLL_STEP_PX
    if (delta === 0) return
    if (vertical) scroller.scrollTop += delta
    else scroller.scrollLeft += delta
  }, [scrollParent])

  const activate = useCallback(() => {
    const session = sessionRef.current
    if (!session || session.active) return
    session.active = true
    if (session.holdTimer !== null) { clearTimeout(session.holdTimer); session.holdTimer = null }
    setDrag({ group: session.group, itemIndex: session.itemIndex })
    updateTarget()
    // Auto-scroll runs on frames (not pointermove) so holding still at an edge keeps scrolling;
    // the target re-derives each frame because scrolling moves the tiles under a still pointer.
    const step = () => {
      const live = sessionRef.current
      if (!live?.active) return
      edgeScroll()
      updateTarget()
      live.rafId = requestAnimationFrame(step)
    }
    session.rafId = requestAnimationFrame(step)
  }, [edgeScroll, updateTarget])

  const handleTilePointerDown = useCallback((group: string, itemIndex: number, event: React.PointerEvent) => {
    // Interactive children that must not arm a drag (the tile's kebab) stop pointerdown
    // propagation, the same way they already stop click propagation.
    if (event.button !== 0 || sessionRef.current) return

    const body = document.body
    const priorUserSelect = body.style.userSelect
    const priorCursor = body.style.cursor

    const onPointerMove = (moveEvent: PointerEvent) => {
      const session = sessionRef.current
      if (!session || moveEvent.pointerId !== session.pointerId) return
      session.lastX = moveEvent.clientX
      session.lastY = moveEvent.clientY
      if (!session.active) {
        const distance = Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY)
        if (session.pointerType === 'touch') {
          // Movement before the hold elapses is a scroll gesture: let the browser have it.
          if (distance > TOUCH_SCROLL_SLOP_PX) session.detach()
        } else if (distance > MOUSE_DRAG_SLOP_PX) {
          activate()
          // Selection/cursor suppression only for an ACTIVE drag: a plain click must not touch
          // body styles at all.
          body.style.userSelect = 'none'
          body.style.cursor = 'grabbing'
        }
        return
      }
      updateTarget()
    }

    const onPointerEnd = (endEvent: PointerEvent) => {
      const session = sessionRef.current
      if (!session || endEvent.pointerId !== session.pointerId) return
      const completed = session.active && endEvent.type === 'pointerup'
      const { group: dropGroup, itemIndex: fromIndex, insertAt, beforeIndex } = session
      const wasActive = session.active
      session.detach()
      if (!wasActive) return
      // The drop's pointerup synthesizes a click on the tile; without this the drop would also
      // select whatever plate the press started on.
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 0)
      if (completed && insertAt !== null) optionsRef.current.onDrop(dropGroup, fromIndex, insertAt, beforeIndex)
    }

    // Pointer events cannot cancel native scrolling; only a non-passive touchmove listener can.
    // Added for the whole session but inert until the drag activates.
    const onTouchMove = (touchEvent: TouchEvent) => {
      if (sessionRef.current?.active && touchEvent.cancelable) touchEvent.preventDefault()
    }
    // A touch hold fires the platform context menu right around our activation window; an active
    // drag must swallow it (the kebab menu stays available when not dragging).
    const onContextMenu = (menuEvent: Event) => {
      if (sessionRef.current?.active) { menuEvent.preventDefault(); menuEvent.stopPropagation() }
    }

    const detach = () => {
      const session = sessionRef.current
      if (!session) return
      if (session.holdTimer !== null) clearTimeout(session.holdTimer)
      if (session.rafId !== null) cancelAnimationFrame(session.rafId)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('contextmenu', onContextMenu, true)
      body.style.userSelect = priorUserSelect
      body.style.cursor = priorCursor
      sessionRef.current = null
      paintCaret(null)
      setDrag(null)
    }

    const session: DragSession = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      group,
      itemIndex,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      insertAt: null,
      beforeIndex: null,
      holdTimer: null,
      rafId: null,
      detach
    }
    sessionRef.current = session
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('contextmenu', onContextMenu, true)
    if (event.pointerType === 'touch') {
      session.holdTimer = setTimeout(() => {
        activate()
        body.style.userSelect = 'none'
      }, TOUCH_HOLD_MS)
    }
  }, [activate, updateTarget, paintCaret])

  // Unmount with a drag in flight must not leave window listeners or body styles behind.
  useEffect(() => () => sessionRef.current?.detach(), [])

  const shouldSuppressClick = useCallback(() => {
    const suppress = suppressClickRef.current
    suppressClickRef.current = false
    return suppress
  }, [])

  return { drag, setContainerElement, setCaretElement, setTileElement, handleTilePointerDown, shouldSuppressClick }
}

/** The group a flat list's items live in. Private: a single-list caller never names it. */
const SOLE_GROUP = 'items'

/**
 * {@link useListReorderDrag} for a list that is only ever ONE list, which is every caller except
 * the editor's object sidebar.
 *
 * Groups exist for nested lists (objects, and each object's parts). A flat list would otherwise pay
 * for them three times over: a module constant, a wrapper `useMemo`, an `onDrop` that discards the
 * group, and the group threaded through every `setTileElement`/`handleTilePointerDown` in its JSX.
 * This binds all of that once so the flat callers read as they did before groups existed.
 */
export function useSingleListReorderDrag(options: {
  vertical: boolean
  /** Item indices in render order: the order tile extents are read in. */
  itemIndices: readonly number[]
  onDrop: (fromIndex: number, insertAt: number, beforeIndex: number | null) => void
}): {
  drag: ListReorderDragState | null
  setContainerElement: (element: HTMLElement | null) => void
  setCaretElement: (element: HTMLElement | null) => void
  setTileElement: (itemIndex: number, element: HTMLElement | null) => void
  handleTilePointerDown: (itemIndex: number, event: React.PointerEvent) => void
  shouldSuppressClick: () => boolean
} {
  const { vertical, itemIndices, onDrop } = options
  const groups = useMemo(() => [{ key: SOLE_GROUP, itemIndices }], [itemIndices])
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop
  const grouped = useListReorderDrag({
    vertical,
    groups,
    onDrop: useCallback((_group: string, from: number, insertAt: number, before: number | null) => {
      onDropRef.current(from, insertAt, before)
    }, [])
  })
  const { setTileElement: setGroupedTile, handleTilePointerDown: pressGroupedTile } = grouped
  const setTileElement = useCallback(
    (itemIndex: number, element: HTMLElement | null) => setGroupedTile(SOLE_GROUP, itemIndex, element),
    [setGroupedTile]
  )
  const handleTilePointerDown = useCallback(
    (itemIndex: number, event: React.PointerEvent) => pressGroupedTile(SOLE_GROUP, itemIndex, event),
    [pressGroupedTile]
  )
  return { ...grouped, setTileElement, handleTilePointerDown }
}
