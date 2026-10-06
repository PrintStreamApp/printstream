/**
 * Coordinates one viewport's paint pointer gesture around `editorPaintStroke`.
 * The stroke owns surface sampling; this controller owns its history boundary, pointer capture,
 * orbit arbitration, hover, and commit signal. Live callbacks stay with the viewport mount.
 */
import type { PaintHit } from './editorPaintStroke'

interface PaintStrokeGesture {
  readonly active: boolean
  start: (hit: PaintHit, x: number, y: number) => void
  move: (x: number, y: number) => PaintHit | null
  reset: () => void
}

interface PaintPointerOptions {
  canvas: HTMLCanvasElement
  stroke: PaintStrokeGesture
  hitOnSelected: (event: PointerEvent) => PaintHit | null
  updateHover: (hit: PaintHit | null) => void
  hoverVisible: () => boolean
  clearHover: () => void
  recordHistory: () => void
  setInteractionActive: (active: boolean) => void
  setOrbitEnabled: (enabled: boolean) => void
  regenerateThumbnail: () => void
  paintCommitted: () => void
}

/** Return paint press, move, release, and teardown handlers for one canvas. */
export function createEditorPaintPointerInteraction(options: PaintPointerOptions) {
  const {
    canvas,
    stroke,
    hitOnSelected,
    updateHover,
    hoverVisible,
    clearHover,
    recordHistory,
    setInteractionActive,
    setOrbitEnabled,
    regenerateThumbnail,
    paintCommitted
  } = options
  let dragPointerId: number | null = null

  return {
    /** A miss leaves the press available for normal selection. */
    begin(event: PointerEvent): boolean {
      const hit = hitOnSelected(event)
      if (!hit) return false

      recordHistory()
      dragPointerId = event.pointerId
      setInteractionActive(true)
      setOrbitEnabled(false)
      canvas.setPointerCapture(event.pointerId)
      stroke.start(hit, event.clientX, event.clientY)
      updateHover(hit)
      return true
    },
    /** Stroke sampling already returns the last hit, avoiding a second raycast for hover. */
    move(event: PointerEvent, hoverMode: boolean): boolean {
      if (hoverMode) {
        if (stroke.active) {
          updateHover(stroke.move(event.clientX, event.clientY))
          return true
        }
        updateHover(hitOnSelected(event))
      } else if (hoverVisible()) {
        clearHover()
      }
      return false
    },
    /** A paint commit changes mutable state and must signal consumers once per stroke. */
    finish(event: PointerEvent): boolean {
      if (!stroke.active) return false
      stroke.reset()
      dragPointerId = null
      setInteractionActive(false)
      setOrbitEnabled(true)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      regenerateThumbnail()
      paintCommitted()
      return true
    },
    /** Cancel the capture without committing when the scene is torn down mid-stroke. */
    reset() {
      if (!stroke.active) return
      stroke.reset()
      setInteractionActive(false)
      setOrbitEnabled(true)
      if (dragPointerId !== null && canvas.hasPointerCapture(dragPointerId)) {
        canvas.releasePointerCapture(dragPointerId)
      }
      dragPointerId = null
    }
  }
}
