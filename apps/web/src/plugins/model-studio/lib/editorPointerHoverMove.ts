/**
 * Routes pointer motion across text, cut, paint, measure, face preview, and active dragging.
 * Text and paint drags consume motion; cut cursor and measure preview update before a body drag.
 * The viewport owns the live tool controllers and supplies them for each mounted scene.
 */
import * as THREE from 'three'
import { paintChannelForGizmoMode, type GizmoMode } from '../editorGeometry'

interface PointerHoverMoveOptions {
  event: PointerEvent
  mode: GizmoMode
  moveText: (event: PointerEvent, active: boolean) => boolean
  updateCutHover: (event: PointerEvent) => void
  movePaint: (event: PointerEvent, active: boolean) => boolean
  updateMeasureHover: (event: PointerEvent, active: boolean) => void
  faceHull: THREE.Mesh | null
  aimPointerRay: (event: PointerEvent) => void
  raycaster: THREE.Raycaster
  highlightFace: (hull: THREE.Mesh, faceIndex: number | null) => void
  moveActiveDrag: (event: PointerEvent) => void
}

/** Preserve tool ownership and preview order for one pointer move. */
export function handleEditorPointerHoverMove(options: PointerHoverMoveOptions): void {
  const {
    event, mode, moveText, updateCutHover, movePaint, updateMeasureHover,
    faceHull, aimPointerRay, raycaster, highlightFace, moveActiveDrag
  } = options

  if (moveText(event, mode === 'text')) return
  updateCutHover(event)
  if (movePaint(event, paintChannelForGizmoMode(mode) !== null || mode === 'brimEars')) return
  updateMeasureHover(event, mode === 'measure')

  if (mode === 'layFace' && faceHull) {
    aimPointerRay(event)
    const hit = raycaster.intersectObject(faceHull, false).find((entry) => entry.faceIndex != null)
    highlightFace(faceHull, hit?.faceIndex ?? null)
  }

  moveActiveDrag(event)
}
