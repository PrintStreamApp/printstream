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
 *   blocker prevents the page/strip from scrolling under the drag — this must be a raw listener
 *   because pointer events cannot cancel native scrolling. (Touch long-press previously opened
 *   the tile's context menu; that menu stays reachable via the tile's kebab button.)
 *
 * The drop lands in an insertion GAP between tiles (0..N), never on a tile — see
 * `lib/listReorder.ts` for why. A pointer released outside the strip (plus a margin)
 * cancels the drag, which is also the escape hatch for a drag the user regrets.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
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

export interface ListReorderDragState {
  /** Live index of the plate being dragged. */
  itemIndex: number
  /** Insertion gap (0..plateCount) the drop would land in; null = outside the strip, drop cancels. */
  insertAt: number | null
  /** Caret centre along the strip axis, in the scroll container's CONTENT coordinates. */
  caretOffset: number | null
}

interface DragSession {
  pointerId: number
  pointerType: string
  itemIndex: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  active: boolean
  /** Mirror of the published insertAt, readable synchronously at drop time. */
  insertAt: number | null
  holdTimer: ReturnType<typeof setTimeout> | null
  rafId: number | null
  detach: () => void
}

export function useListReorderDrag(options: {
  vertical: boolean
  /** Live plate indices in strip order — the order tile extents are read in. */
  itemIndices: readonly number[]
  onDrop: (fromIndex: number, insertAt: number) => void
}): {
  drag: ListReorderDragState | null
  setContainerElement: (element: HTMLElement | null) => void
  setTileElement: (itemIndex: number, element: HTMLElement | null) => void
  handleTilePointerDown: (itemIndex: number, event: React.PointerEvent) => void
  /** True exactly once after a drag completed — swallow the click the drop synthesizes. */
  shouldSuppressClick: () => boolean
} {
  const [drag, setDrag] = useState<ListReorderDragState | null>(null)
  const containerRef = useRef<HTMLElement | null>(null)
  const tilesRef = useRef(new Map<number, HTMLElement>())
  const sessionRef = useRef<DragSession | null>(null)
  const suppressClickRef = useRef(false)
  // Latest options for the window listeners, which outlive any single render.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const setContainerElement = useCallback((element: HTMLElement | null) => {
    containerRef.current = element
  }, [])

  const setTileElement = useCallback((itemIndex: number, element: HTMLElement | null) => {
    if (element) tilesRef.current.set(itemIndex, element)
    else tilesRef.current.delete(itemIndex)
  }, [])

  /** Tile extents along the strip axis in viewport coords + the container rect, or null. */
  const measure = useCallback(() => {
    const container = containerRef.current
    if (!container) return null
    const { vertical, itemIndices } = optionsRef.current
    const tiles: ListTileExtent[] = []
    const contentOffsets: ListTileExtent[] = []
    const containerRect = container.getBoundingClientRect()
    const scroll = vertical ? container.scrollTop : container.scrollLeft
    const containerStart = vertical ? containerRect.top : containerRect.left
    for (const itemIndex of itemIndices) {
      const tile = tilesRef.current.get(itemIndex)
      if (!tile || !tile.isConnected) continue
      const rect = tile.getBoundingClientRect()
      const start = vertical ? rect.top : rect.left
      const end = vertical ? rect.bottom : rect.right
      tiles.push({ start, end })
      contentOffsets.push({ start: start - containerStart + scroll, end: end - containerStart + scroll })
    }
    return { container, containerRect, tiles, contentOffsets }
  }, [])

  /** Recompute the insertion target from the last pointer position and publish it. */
  const updateTarget = useCallback(() => {
    const session = sessionRef.current
    if (!session?.active) return
    const measured = measure()
    if (!measured) return
    const { containerRect, tiles, contentOffsets } = measured
    const { vertical } = optionsRef.current
    const outside =
      session.lastX < containerRect.left - OUTSIDE_CANCEL_MARGIN_PX
      || session.lastX > containerRect.right + OUTSIDE_CANCEL_MARGIN_PX
      || session.lastY < containerRect.top - OUTSIDE_CANCEL_MARGIN_PX
      || session.lastY > containerRect.bottom + OUTSIDE_CANCEL_MARGIN_PX
    const pointer = vertical ? session.lastY : session.lastX
    const insertAt = outside ? null : listInsertionGap(tiles, pointer)
    const caretOffset = insertAt === null ? null : listInsertionCaretCenter(contentOffsets, insertAt)
    session.insertAt = insertAt
    setDrag((current) => (
      current && current.insertAt === insertAt && current.caretOffset === caretOffset
        ? current
        : { itemIndex: session.itemIndex, insertAt, caretOffset }
    ))
  }, [measure])

  /** Scroll the strip when the drag hovers near either end, so off-screen gaps are reachable. */
  const edgeScroll = useCallback(() => {
    const session = sessionRef.current
    const container = containerRef.current
    if (!session?.active || !container) return
    const rect = container.getBoundingClientRect()
    const { vertical } = optionsRef.current
    const pointer = vertical ? session.lastY : session.lastX
    const start = vertical ? rect.top : rect.left
    const end = vertical ? rect.bottom : rect.right
    let delta = 0
    if (pointer < start + EDGE_SCROLL_ZONE_PX) delta = -EDGE_SCROLL_STEP_PX
    else if (pointer > end - EDGE_SCROLL_ZONE_PX) delta = EDGE_SCROLL_STEP_PX
    if (delta === 0) return
    if (vertical) container.scrollTop += delta
    else container.scrollLeft += delta
  }, [])

  const activate = useCallback(() => {
    const session = sessionRef.current
    if (!session || session.active) return
    session.active = true
    if (session.holdTimer !== null) { clearTimeout(session.holdTimer); session.holdTimer = null }
    setDrag({ itemIndex: session.itemIndex, insertAt: null, caretOffset: null })
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

  const handleTilePointerDown = useCallback((itemIndex: number, event: React.PointerEvent) => {
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
          // Movement before the hold elapses is a scroll gesture — let the browser have it.
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
      const { itemIndex: fromIndex, insertAt } = session
      const wasActive = session.active
      session.detach()
      if (!wasActive) return
      // The drop's pointerup synthesizes a click on the tile; without this the drop would also
      // select whatever plate the press started on.
      suppressClickRef.current = true
      setTimeout(() => { suppressClickRef.current = false }, 0)
      if (completed && insertAt !== null) optionsRef.current.onDrop(fromIndex, insertAt)
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
      setDrag(null)
    }

    const session: DragSession = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      itemIndex,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      insertAt: null,
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
  }, [activate, updateTarget])

  // Unmount with a drag in flight must not leave window listeners or body styles behind.
  useEffect(() => () => sessionRef.current?.detach(), [])

  const shouldSuppressClick = useCallback(() => {
    const suppress = suppressClickRef.current
    suppressClickRef.current = false
    return suppress
  }, [])

  return { drag, setContainerElement, setTileElement, handleTilePointerDown, shouldSuppressClick }
}
