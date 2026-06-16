import { useEffect } from 'react'

/**
 * Closes a manually-controlled (non-`Dropdown`) menu when a pointer-down lands
 * outside both the menu and its anchor(s).
 *
 * Use this for menus that are anchored and toggled by hand (open state owned by
 * the caller) rather than driven by Joy's `Dropdown`, which already wires its
 * own clickaway. The menu element is located by its DOM id (`menuId`); the
 * anchor refs are excluded so clicking the trigger toggles rather than closes.
 */
export function useControlledMenuClickAway(
  open: boolean,
  menuId: string,
  onClose: () => void,
  anchorRefs: ReadonlyArray<{ current: HTMLElement | null }>
): void {
  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (anchorRefs.some((anchorRef) => anchorRef.current?.contains(target))) return
      if (document.getElementById(menuId)?.contains(target)) return
      onClose()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [anchorRefs, menuId, onClose, open])
}
