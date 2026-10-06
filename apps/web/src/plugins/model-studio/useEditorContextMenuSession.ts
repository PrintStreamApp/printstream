/**
 * Owns the editor's object/part context menu state and outside-interaction lifecycle.
 * Viewport presses enter through a stable ref; row menus can set the same state directly.
 * A menu's own scroll stays open, while scrolling elsewhere invalidates its cursor anchor.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { isInsideContextMenu, type ContextMenuAnchor } from './contextMenuChrome'
import type { PartMember } from './lib/selectionModel'

type EditorContextMenu = (ContextMenuAnchor & (
  | { kind: 'object'; key: string }
  | { kind: 'parts'; objectId: number; members: ReadonlyArray<PartMember> }
)) | null

interface ContextMenuSessionOptions {
  allSelectedKeysRef: MutableRefObject<() => string[]>
  selectExclusiveRef: MutableRefObject<(key: string | null) => void>
}

/** Return shared context menu state, viewport entry, and Escape suppression refs. */
export function useEditorContextMenuSession(options: ContextMenuSessionOptions) {
  const { allSelectedKeysRef, selectExclusiveRef } = options
  const [contextMenu, setContextMenu] = useState<EditorContextMenu>(null)
  const contextMenuListboxRef = useRef<HTMLDivElement | null>(null)
  const contextMenuOpenRef = useRef(false)
  contextMenuOpenRef.current = contextMenu !== null
  const suppressEditorEscapeRef = useRef(false)

  const openContextMenuRef = useRef<(menu: (ContextMenuAnchor & { key: string }) | null) => void>(() => {})
  openContextMenuRef.current = (menu) => {
    if (!menu) {
      setContextMenu(null)
      return
    }
    // A right-click inside the current bulk selection preserves it. An unrelated object becomes
    // the sole selection before its menu opens, matching the sidebar row path.
    if (!allSelectedKeysRef.current().includes(menu.key)) selectExclusiveRef.current(menu.key)
    setContextMenu({ x: menu.x, y: menu.y, align: menu.align, kind: 'object', key: menu.key })
  }

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const insideMenu = (target: EventTarget | null) => isInsideContextMenu(contextMenuListboxRef.current, target)
    const onPointerDown = (event: PointerEvent) => {
      if (!insideMenu(event.target)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: Event) => {
      if (!insideMenu(event.target)) close()
    }

    // Capture outside presses and scrolls before row handlers run. Joy's bare anchored Menu lacks
    // its Dropdown's click-away wiring, and an off-menu scroll moves the row under its old anchor.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [contextMenu])

  return {
    contextMenu,
    setContextMenu,
    openContextMenuRef,
    contextMenuListboxRef,
    contextMenuOpenRef,
    suppressEditorEscapeRef
  }
}
