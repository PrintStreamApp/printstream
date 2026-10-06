/**
 * Render invalidation listeners for the long-lived editor viewport effect.
 *
 * Orbit damping emits change events after a drag ends, and pointer motion
 * changes hover aids without a React commit. Both must request a frame while
 * mounted and release their listeners before renderer disposal.
 */
type OrbitChangeSource = {
  addEventListener: (type: 'change', listener: () => void) => void
  removeEventListener: (type: 'change', listener: () => void) => void
}

/** Install camera and pointer render triggers, returning their matching cleanup. */
export function installEditorRenderTriggers(
  canvas: HTMLElement,
  orbit: OrbitChangeSource,
  requestRender: () => void
): () => void {
  orbit.addEventListener('change', requestRender)
  const onPointerMove = () => requestRender()
  canvas.addEventListener('pointermove', onPointerMove)

  return () => {
    orbit.removeEventListener('change', requestRender)
    canvas.removeEventListener('pointermove', onPointerMove)
  }
}
