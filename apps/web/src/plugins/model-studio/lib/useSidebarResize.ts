/**
 * Desktop drag-resize for the editor's sidebar (the Settings/Objects panel column).
 *
 * Owns the persisted width (a per-device localStorage display pref, repo convention) and the
 * pointer wiring for the grab strip on the panel's inner edge: pointer capture keeps move events on
 * the handle for the whole drag, and the new width is measured from whichever panel edge the grid
 * holds still — the OUTER one, since the flexible viewport column takes the rest. That edge flips
 * with the sidebar's side, so the caller passes it in; getting it wrong makes the drag run
 * backwards. Widths are clamped so neither the panel nor the 3D viewport can collapse.
 * Double-click resets to the default. The mobile (xs) layout stacks and never renders the handle,
 * so this is desktop-only by construction.
 */
import { useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useLocalStorageState } from '../../../hooks/useLocalStorageState'
// Type-only: the settings dialog owns the viewport-preference contract (core), this consumes it.
import type { EditorSidebarSide } from '../../../components/library/EditorSettingsDialog'

export const EDITOR_SIDEBAR_DEFAULT_WIDTH = 388
export const EDITOR_SIDEBAR_MIN_WIDTH = 300
export const EDITOR_SIDEBAR_MAX_WIDTH = 680

export function clampSidebarWidth(value: number): number {
  return Math.min(EDITOR_SIDEBAR_MAX_WIDTH, Math.max(EDITOR_SIDEBAR_MIN_WIDTH, Math.round(value)))
}

function parseStoredWidth(raw: string): number | null {
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? clampSidebarWidth(value) : null
}

export interface SidebarResizeHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
}

export function useSidebarResize(side: EditorSidebarSide = 'right'): { sidebarWidth: number; resizeHandleProps: SidebarResizeHandleProps } {
  const [sidebarWidth, setSidebarWidth] = useLocalStorageState<number>(
    'editor.sidebarWidth',
    EDITOR_SIDEBAR_DEFAULT_WIDTH,
    parseStoredWidth,
    String
  )

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    // The handle lives inside the panel column. The panel's OUTER edge is the one the grid holds
    // still while dragging (the flexible viewport column absorbs the change), so the width is
    // always measured from it — which edge that is depends on the side.
    const panelBounds = handle.parentElement?.getBoundingClientRect()
    if (!panelBounds) return
    const fixedEdge = side === 'left' ? panelBounds.left : panelBounds.right
    handle.setPointerCapture(event.pointerId)
    const onMove = (moveEvent: PointerEvent) => setSidebarWidth(clampSidebarWidth(
      side === 'left' ? moveEvent.clientX - fixedEdge : fixedEdge - moveEvent.clientX
    ))
    const stop = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }, [side, setSidebarWidth])

  const onDoubleClick = useCallback(() => setSidebarWidth(EDITOR_SIDEBAR_DEFAULT_WIDTH), [setSidebarWidth])

  return { sidebarWidth, resizeHandleProps: { onPointerDown, onDoubleClick } }
}
