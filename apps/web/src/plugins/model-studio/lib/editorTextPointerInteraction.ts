/**
 * Owns one viewport mount's text drag gesture. The caller supplies live scene picks and editor
 * callbacks; this controller keeps pointer capture, orbit arbitration, hover, and placement in
 * sync. A miss during movement leaves the text at its last surface point.
 */
import type * as THREE from 'three'
import type { TextInteraction } from '../editorGeometry'
import type { PaintHit } from './editorPaintStroke'

interface TextPointerOptions {
  canvas: HTMLCanvasElement
  overText: (event: PointerEvent) => boolean
  hitOnSelected: (event: PointerEvent) => PaintHit | null
  recordHistory: () => void
  setInteractionActive: (active: boolean) => void
  setOrbitEnabled: (enabled: boolean) => void
  setTextInteraction: (state: TextInteraction) => void
  placeTextAt: (point: THREE.Vector3, normal: THREE.Vector3, phase: 'start' | 'move') => void
  regenerateThumbnail: () => void
}

/** Return gesture handlers for text hover and surface dragging within one viewport mount. */
export function createEditorTextPointerInteraction(options: TextPointerOptions) {
  const {
    canvas,
    overText,
    hitOnSelected,
    recordHistory,
    setInteractionActive,
    setOrbitEnabled,
    setTextInteraction,
    placeTextAt,
    regenerateThumbnail
  } = options
  let dragPointerId: number | null = null

  const updateHover = (event: PointerEvent) => {
    const hovering = overText(event)
    setTextInteraction(hovering ? 'hover' : 'idle')
    canvas.style.cursor = hovering ? 'grab' : ''
  }

  return {
    /** A press on the model outside the text remains available to orbit and select. */
    begin(event: PointerEvent): boolean {
      if (!overText(event)) return false
      const hit = hitOnSelected(event)
      if (!hit) return false

      recordHistory()
      dragPointerId = event.pointerId
      setInteractionActive(true)
      setOrbitEnabled(false)
      canvas.setPointerCapture(event.pointerId)
      setTextInteraction('drag')
      canvas.style.cursor = 'grabbing'
      placeTextAt(hit.point.clone(), hit.normal.clone(), 'start')
      return true
    },
    /** Update idle hover or move the text only while the pointer hits a printable surface. */
    move(event: PointerEvent, textMode: boolean): boolean {
      if (dragPointerId === null) {
        if (textMode) updateHover(event)
        return false
      }

      const hit = hitOnSelected(event)
      if (hit) placeTextAt(hit.point.clone(), hit.normal.clone(), 'move')
      return true
    },
    /** Finish the gesture and refresh the active plate's thumbnail once. */
    finish(event: PointerEvent): boolean {
      if (dragPointerId === null) return false
      dragPointerId = null
      setInteractionActive(false)
      setOrbitEnabled(true)
      updateHover(event)
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
      regenerateThumbnail()
      return true
    },
    /** Release a captured pointer before the viewport's canvas and orbit controls are disposed. */
    reset() {
      if (dragPointerId === null) return
      const pointerId = dragPointerId
      dragPointerId = null
      setInteractionActive(false)
      setOrbitEnabled(true)
      canvas.style.cursor = ''
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId)
    }
  }
}
