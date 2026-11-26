/**
 * Restore accessible listboxes owned by the active dialog after a nested modal
 * closes. Joy keeps closed Select popups mounted under body; its ModalManager
 * hides those siblings but restores only the surviving modal root. This repair
 * follows expanded controls inside that root and never unhides background UI.
 */
import { useEffect } from 'react'

/** An expanded control owns its portal even though the portal is outside the modal DOM. */
export function isDialogPopupEvent(root: HTMLElement | null, target: unknown): boolean {
  const Element = root?.ownerDocument.defaultView?.Element
  if (!root || !Element || !(target instanceof Element)) return false
  for (const control of root.querySelectorAll('[aria-expanded="true"][aria-controls]')) {
    for (const id of (control.getAttribute('aria-controls') ?? '').split(/\s+/)) {
      const popup = root.ownerDocument.getElementById(id)
      if (popup && ['listbox', 'menu'].includes(popup.getAttribute('role') ?? '')
        && (popup.contains(target) || control.contains(target))) return true
    }
  }
  return false
}

/** Keep Select/Autocomplete portals in the accessibility tree of their active modal. */
export function useDialogPopupAccessibility(root: HTMLElement | null, open: boolean): void {
  useEffect(() => {
    const Observer = root?.ownerDocument.defaultView?.MutationObserver
    if (!open || !root || !Observer) return

    const restoreOwnedPopups = () => {
      if (!root.isConnected || root.closest('[aria-hidden="true"]')) return
      const controls = root.querySelectorAll('[role="combobox"][aria-expanded="true"][aria-controls]')
      for (const control of controls) {
        for (const id of (control.getAttribute('aria-controls') ?? '').split(/\s+/)) {
          const popup = root.ownerDocument.getElementById(id)
          if (popup?.getAttribute('role') === 'listbox' && popup.getAttribute('aria-hidden') === 'true') {
            popup.removeAttribute('aria-hidden')
          }
        }
      }
    }
    const observer = new Observer(restoreOwnedPopups)
    observer.observe(root.ownerDocument.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'aria-expanded', 'aria-controls']
    })
    restoreOwnedPopups()
    return () => observer.disconnect()
  }, [root, open])
}
