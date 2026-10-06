/**
 * Resolves cut-connector clicks and hover from the viewport's live scene.
 * Existing markers take precedence over the section and infinite plane so a placed connector
 * remains removable even when its marker covers the surface where it was added.
 */
import * as THREE from 'three'

export interface CutConnectorTargets {
  plane: THREE.Object3D | null
  section: THREE.Object3D | null
  markers: THREE.Object3D[]
}

export type CutConnectorEdit =
  | { kind: 'add'; worldPoint: THREE.Vector3 }
  | { kind: 'remove'; id: string }

/** Return true when a marker or cut surface accepted the click; a parallel ray has no target. */
export function pickCutConnectorEdit(raycaster: THREE.Raycaster, targets: CutConnectorTargets): CutConnectorEdit | null {
  const markerHit = raycaster.intersectObjects(targets.markers, true)[0]
  if (markerHit) {
    let node: THREE.Object3D | null = markerHit.object
    while (node && typeof node.userData.connectorId !== 'string') node = node.parent
    const id = node?.userData.connectorId
    if (typeof id === 'string') return { kind: 'remove', id }
  }

  // A visible section hit is exact, without a separate containment test.
  if (targets.section) {
    const sectionHit = raycaster.intersectObject(targets.section, false)[0]
    if (sectionHit) return { kind: 'add', worldPoint: sectionHit.point.clone() }
  }

  if (!targets.plane) return null
  // The preview quad can be only a few pixels tall. BambuStudio projects onto its infinite
  // plane and lets the edit policy check whether that point lies inside the cut contour.
  targets.plane.updateMatrixWorld()
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(targets.plane.matrixWorld).normalize()
  const origin = new THREE.Vector3().setFromMatrixPosition(targets.plane.matrixWorld)
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
  const hit = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  return hit ? { kind: 'add', worldPoint: hit } : null
}

interface CutConnectorHoverOptions {
  canvas: HTMLCanvasElement
  camera: THREE.Camera
  pointer: THREE.Vector2
  raycaster: THREE.Raycaster
  isActive: () => boolean
  getSection: () => THREE.Object3D | null
  showHover: (point: THREE.Vector3 | null) => void
}

/**
 * Track the cut section under the pointer and clear the copy cursor when the tool ends.
 * The section and mode are read on each move because this controller lives for one viewport mount.
 */
export function createCutConnectorHover({
  canvas,
  camera,
  pointer,
  raycaster,
  isActive,
  getSection,
  showHover
}: CutConnectorHoverOptions) {
  let cursorShown = false
  const clearCursor = () => {
    if (!cursorShown) return
    canvas.style.cursor = ''
    cursorShown = false
  }

  return {
    update: (event: PointerEvent) => {
      if (!isActive()) {
        clearCursor()
        return
      }
      const section = getSection()
      if (!section) {
        showHover(null)
        clearCursor()
        return
      }

      const rect = canvas.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObject(section, false)[0]
      showHover(hit ? hit.point.clone() : null)
      canvas.style.cursor = hit ? 'copy' : ''
      cursorShown = hit != null
    },
    dispose: clearCursor
  }
}
