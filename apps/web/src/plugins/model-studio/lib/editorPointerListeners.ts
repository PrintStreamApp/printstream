/**
 * Canvas pointer listener lifecycle for the editor viewport.
 *
 * The capture-phase ownership claim must precede the tool handler. Orbit pivot
 * setup follows pointer-down handlers, and hover-exit setup follows pointer
 * move, so a tool can disable orbit before pivot behavior observes its event.
 * Cleanup is split only because the viewport disposes its camera rig between
 * releasing orbit pivot behavior and removing the canvas handlers.
 */
type PointerHandlers = {
  claimSelectedObjectPointer: (event: PointerEvent) => void
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  endBodyDrag: (event: PointerEvent) => void
  onContextMenu: (event: MouseEvent) => void
  installOrbitPivot: () => () => void
  installHoverExit: () => () => void
}

/** Install the canvas pointer family in its required order and return both teardown phases. */
export function installEditorPointerListeners(canvas: HTMLElement, handlers: PointerHandlers) {
  canvas.addEventListener('pointerdown', handlers.claimSelectedObjectPointer, true)
  canvas.addEventListener('pointerdown', handlers.onPointerDown)
  const releaseOrbitPivot = handlers.installOrbitPivot()

  canvas.addEventListener('pointermove', handlers.onPointerMove)
  const releaseHoverExit = handlers.installHoverExit()
  canvas.addEventListener('pointerup', handlers.endBodyDrag)
  canvas.addEventListener('pointercancel', handlers.endBodyDrag)
  canvas.addEventListener('contextmenu', handlers.onContextMenu)

  return {
    releaseOrbitPivot,
    releaseCanvasListeners: () => {
      canvas.removeEventListener('pointerdown', handlers.claimSelectedObjectPointer, true)
      canvas.removeEventListener('pointerdown', handlers.onPointerDown)
      releaseHoverExit()
      canvas.removeEventListener('pointermove', handlers.onPointerMove)
      canvas.removeEventListener('pointerup', handlers.endBodyDrag)
      canvas.removeEventListener('pointercancel', handlers.endBodyDrag)
      canvas.removeEventListener('contextmenu', handlers.onContextMenu)
    }
  }
}
