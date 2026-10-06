/**
 * Finishes a press on the already selected object's body after volume drill-down. Place on face
 * prefers the visible hull pseudo-face and refreshes its highlight after rotation. Move starts
 * a body drag only after a fresh bed-plane hit; other modes leave the camera gesture alone.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import type { GizmoMode } from '../editorGeometry'

interface SelectedObjectPressOptions {
  event: PointerEvent
  group: THREE.Group
  instanceKey: unknown
  mode: GizmoMode
  aimPointerRay: (event: PointerEvent) => void
  raycaster: THREE.Raycaster
  faceHull: THREE.Mesh | null
  placeOnFace: (hit: THREE.Intersection<THREE.Object3D>) => boolean
  afterPlaceOnFace: () => void
  bedPlane: THREE.Plane
  dragPoint: THREE.Vector3
  resetPanelSync: () => void
  beginBodyDrag: (group: THREE.Group, point: THREE.Vector3) => void
  beginCoDrag: (key: string, point: THREE.Vector3) => void
  canvas: Pick<HTMLCanvasElement, 'setPointerCapture'>
  orbit: Pick<OrbitControls, 'enabled'>
}

/** Apply the selected body's active tool, leaving all other modes untouched. */
export function handleEditorSelectedObjectPress(options: SelectedObjectPressOptions): void {
  const {
    event, group, instanceKey, mode, aimPointerRay, raycaster, faceHull,
    placeOnFace, afterPlaceOnFace, bedPlane, dragPoint, resetPanelSync,
    beginBodyDrag, beginCoDrag, canvas, orbit
  } = options

  if (mode === 'layFace') {
    aimPointerRay(event)
    const hit = (faceHull
      ? raycaster.intersectObject(faceHull, false)
      : raycaster.intersectObject(group, true)
    ).find((candidate) => candidate.face)
    if (hit && placeOnFace(hit)) {
      // The hull bakes the old orientation. Rebuild its outline after the new pose is committed.
      afterPlaceOnFace()
    }
    return
  }

  if (mode !== 'translate') return
  aimPointerRay(event)
  if (!raycaster.ray.intersectPlane(bedPlane, dragPoint)) return
  resetPanelSync()
  beginBodyDrag(group, dragPoint)
  if (typeof instanceKey === 'string') beginCoDrag(instanceKey, dragPoint)
  orbit.enabled = false
  canvas.setPointerCapture(event.pointerId)
}
