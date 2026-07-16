/**
 * Desktop drag-resize for the editor's right sidebar (the Settings/Objects panel column).
 *
 * Owns the persisted width (a per-device localStorage display pref, repo convention) and the
 * pointer wiring for the grab strip on the panel's left edge: pointer capture keeps move events on
 * the handle for the whole drag, the new width is the panel's fixed right edge minus the pointer x,
 * clamped so neither the panel nor the 3D viewport can collapse. Double-click resets to the
 * default. The mobile (xs) layout uses a drawer and never renders the handle, so this is
 * desktop-only by construction.
 */
import { useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useLocalStorageState } from '../../../hooks/useLocalStorageState'

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

export function useSidebarResize(): { sidebarWidth: number; resizeHandleProps: SidebarResizeHandleProps } {
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
    // The handle lives inside the panel column, whose RIGHT edge stays fixed while dragging (the
    // grid's flexible column is on the left), so width = right edge - pointer x.
    const rightEdge = handle.parentElement?.getBoundingClientRect().right
    if (rightEdge === undefined) return
    handle.setPointerCapture(event.pointerId)
    const onMove = (moveEvent: PointerEvent) => setSidebarWidth(clampSidebarWidth(rightEdge - moveEvent.clientX))
    const stop = () => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', stop)
      handle.removeEventListener('pointercancel', stop)
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', stop)
    handle.addEventListener('pointercancel', stop)
  }, [setSidebarWidth])

  const onDoubleClick = useCallback(() => setSidebarWidth(EDITOR_SIDEBAR_DEFAULT_WIDTH), [setSidebarWidth])

  return { sidebarWidth, resizeHandleProps: { onPointerDown, onDoubleClick } }
}
