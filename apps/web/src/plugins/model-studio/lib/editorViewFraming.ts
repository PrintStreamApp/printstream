/**
 * Owns the editor viewport's view-preset and default-framing policy.
 *
 * The camera rig in viewportCamera.ts owns animation and orbit pivot behavior. This adapter
 * supplies the editor's live bed centre, home direction, and reset semantics to that rig.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import type { ViewportCameraRig } from './viewportCamera'
import { VIEW_PRESET_CONFIG, type ViewPreset } from './viewCube'

export interface EditorViewFramingOptions {
  camera: THREE.PerspectiveCamera
  orbit: Pick<OrbitControls, 'target' | 'update'>
  rig: Pick<ViewportCameraRig, 'swingTo' | 'cancel'>
  getBedCenter: () => { x: number; y: number }
  getViewDistance: () => number
  planeZ: number
  homeDirection: THREE.Vector3
}

/**
 * Return stable callbacks for a mounted viewport. A preset click resets framing, while a
 * Shift click retains the exact current pivot and distance. Home framing cancels a swing first
 * so its next animation frame cannot overwrite a resize or plate-switch reframe.
 */
export function createEditorViewFraming(options: EditorViewFramingOptions) {
  const {
    camera, orbit, rig, getBedCenter, getViewDistance, planeZ, homeDirection
  } = options

  const applyViewDirection = (
    direction: { x: number; y: number; z: number },
    { reframe }: { reframe: boolean } = { reframe: true }
  ) => {
    // A Shift click preserves pan and zoom. Re-grounding its pivot would change the orbit radius.
    const center = getBedCenter()
    rig.swingTo({
      direction,
      ...(reframe
        ? { target: new THREE.Vector3(center.x, center.y, planeZ), distance: getViewDistance() }
        : {})
    })
  }

  const applyViewPreset = (preset: ViewPreset) => {
    // OrbitControls measures polar angle from camera.up, so keep world Z across every preset.
    applyViewDirection(VIEW_PRESET_CONFIG[preset].direction)
  }

  const frameDefaultView = () => {
    rig.cancel()
    const center = getBedCenter()
    const target = new THREE.Vector3(center.x, center.y, planeZ)
    const distance = getViewDistance()
    camera.up.set(0, 0, 1)
    camera.position.set(
      target.x + distance * homeDirection.x,
      target.y + distance * homeDirection.y,
      target.z + distance * homeDirection.z
    )
    camera.lookAt(target)
    orbit.target.copy(target)
    orbit.update()
  }

  return { applyViewDirection, applyViewPreset, frameDefaultView }
}
