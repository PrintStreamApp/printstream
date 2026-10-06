/**
 * Window and container listeners for the editor viewport's mounted scene.
 * Resize keeps the renderer current; a global right-click dismisses Joy menus
 * while suppressing the editor modal's Escape close for that dispatch only.
 */
type Options = {
  container: HTMLElement
  onResize: () => void
  suppressEditorEscapeRef: { current: boolean }
}

/** Install viewport window listeners and return their matching cleanup. */
export function installEditorWindowListeners({ container, onResize, suppressEditorEscapeRef }: Options): () => void {
  window.addEventListener('resize', onResize)
  const resizeObserver = new ResizeObserver(onResize)
  resizeObserver.observe(container)

  // Joy's menu click-away ignores right clicks. Escape closes open menus, but
  // the modal must not treat this synthetic Escape as a request to close.
  const onGlobalContextMenu = () => {
    suppressEditorEscapeRef.current = true
    try {
      for (const listbox of document.querySelectorAll('[role="menu"]')) {
        listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
      }
    } finally {
      suppressEditorEscapeRef.current = false
    }
  }
  window.addEventListener('contextmenu', onGlobalContextMenu, true)

  return () => {
    window.removeEventListener('resize', onResize)
    window.removeEventListener('contextmenu', onGlobalContextMenu, true)
    resizeObserver.disconnect()
  }
}
