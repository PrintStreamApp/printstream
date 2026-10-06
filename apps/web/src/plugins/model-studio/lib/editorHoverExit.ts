/**
 * Canvas hover-exit listener for transient editor aids.
 *
 * The viewport effect owns the scene and passes current callbacks here. A
 * pointer can leave without another move, so paint and measure previews must
 * clear on the exit event itself. The returned cleanup is required before the
 * effect disposes the canvas and its scene objects.
 */
export type EditorHoverExitHandlers = {
  clearBrushHover: () => void
  clearMeasureHover: () => void
  clearFaceHighlight: () => void
  requestRender: () => void
}

/** Install hover cleanup on the canvas and return its matching listener removal. */
export function installEditorHoverExit(canvas: HTMLElement, handlers: EditorHoverExitHandlers): () => void {
  const onPointerLeave = () => {
    handlers.clearBrushHover()
    handlers.clearMeasureHover()
    handlers.clearFaceHighlight()
    handlers.requestRender()
  }
  canvas.addEventListener('pointerleave', onPointerLeave)
  return () => canvas.removeEventListener('pointerleave', onPointerLeave)
}
