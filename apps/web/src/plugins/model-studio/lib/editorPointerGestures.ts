/**
 * Routes an active viewport drag and finishes gestures in tool, selection, tower, part,
 * then object order.
 * The viewport still owns the controllers and installs this callback on its canvas.
 */
import type * as THREE from 'three'

interface ActiveDragMoveOptions {
  isBodyActive: () => boolean
  isPartActive: () => boolean
  isTowerActive: () => boolean
  aimPointerRay: (event: PointerEvent) => void
  raycaster: THREE.Raycaster
  bedPlane: THREE.Plane
  dragPoint: THREE.Vector3
  moveTower: (point: THREE.Vector3) => boolean
  movePart: (point: THREE.Vector3) => boolean
  moveBody: (point: THREE.Vector3) => boolean
  onBodyDragMove: (event: PointerEvent) => void
}

/** Move the active target only after the shared pointer ray hits the bed plane. */
export function createEditorActiveDragMove(options: ActiveDragMoveOptions): (event: PointerEvent) => void {
  return (event) => {
    // A part drag moves a mesh inside an object, so it must reach this gate even with no body drag.
    if (!options.isBodyActive() && !options.isPartActive() && !options.isTowerActive()) return
    options.aimPointerRay(event)
    if (!options.raycaster.ray.intersectPlane(options.bedPlane, options.dragPoint)) return
    if (options.moveTower(options.dragPoint)) return
    if (options.movePart(options.dragPoint)) return
    if (options.moveBody(options.dragPoint)) options.onBodyDragMove(event)
  }
}

interface PointerReleaseOptions {
  canvas: Pick<HTMLCanvasElement, 'hasPointerCapture' | 'releasePointerCapture'>
  orbit: { enabled: boolean }
  releaseSelectionClaim: (event: PointerEvent) => void
  finishMeasure: (event: PointerEvent) => boolean
  finishText: (event: PointerEvent) => boolean
  finishPaint: (event: PointerEvent) => boolean
  finishSelectionClick: (event: PointerEvent) => void
  clearBodyPeers: () => void
  finishTower: () => boolean
  finishPart: () => THREE.Object3D | null
  finishBody: () => THREE.Group | null
  syncSelectedTransform: (target: THREE.Object3D) => void
  regenerateThumbnail: () => void
}

/** Restore orbit and release capture only for a completed object, part, or tower drag. */
export function createEditorPointerRelease(options: PointerReleaseOptions): (event: PointerEvent) => void {
  const releaseDrag = (event: PointerEvent) => {
    options.orbit.enabled = true
    if (options.canvas.hasPointerCapture(event.pointerId)) {
      options.canvas.releasePointerCapture(event.pointerId)
    }
  }

  return (event) => {
    options.releaseSelectionClaim(event)
    if (options.finishMeasure(event)) return
    if (options.finishText(event)) return
    if (options.finishPaint(event)) return

    options.finishSelectionClick(event)
    options.clearBodyPeers()
    if (options.finishTower()) {
      releaseDrag(event)
      return
    }

    // The panel reads a dragged part's placement from that part, not from its host object.
    const part = options.finishPart()
    if (part) {
      options.syncSelectedTransform(part)
      releaseDrag(event)
      options.regenerateThumbnail()
      return
    }

    const group = options.finishBody()
    if (!group) return
    options.syncSelectedTransform(group)
    releaseDrag(event)
    options.regenerateThumbnail()
  }
}
