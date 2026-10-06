/**
 * Configures the editor's TransformControls handles for bed-bound manipulation.
 * The three-stdlib gizmo is internal, so absent internals leave the stock control usable.
 * The viewport releases the update wrapper before disposing the control.
 */
import * as THREE from 'three'
import type { TransformControls } from 'three-stdlib'

type GizmoLayers = {
  gizmo?: Record<string, THREE.Object3D>
  picker?: Record<string, THREE.Object3D>
  helper?: Record<string, THREE.Object3D>
  updateMatrixWorld?: (force?: boolean) => void
}

const REMOVED_HANDLES = {
  translate: new Set(['XYZ', 'Z', 'YZ', 'XZ']),
  scale: new Set(['XYZ'])
}

/** Keep the editor's fixed-direction translate handles after the library updates them. */
function pinTranslateHandles(gizmo: GizmoLayers): void {
  for (const group of [gizmo.gizmo?.translate, gizmo.picker?.translate]) {
    if (!group) continue

    for (const handle of group.children) {
      if (Math.abs(handle.scale.x) < 1e-9 || Math.abs(handle.scale.y) < 1e-9
        || Math.abs(handle.scale.z) < 1e-9) continue

      // The library flips a handle with a negative scale and a forward/back visibility swap.
      // Retain its edge-on hiding, which uses a near-zero scale.
      if (handle.scale.x < 0 || handle.scale.y < 0 || handle.scale.z < 0) {
        handle.scale.set(Math.abs(handle.scale.x), Math.abs(handle.scale.y), Math.abs(handle.scale.z))
        // The library has already composed matrixWorld by this point. Recompose it for this frame.
        handle.updateMatrixWorld(true)
      }

      const tag = (handle as THREE.Object3D & { tag?: string }).tag
      if (tag === 'fwd') handle.visible = true
      else if (tag === 'bwd') handle.visible = false
    }
  }
}

/**
 * Remove out-of-bed handles and pin translation arrows to positive X/Y.
 * Returns cleanup for the internal matrix update wrapper. The wrapper must run after the
 * library update because rendering invokes that update after the viewport's frame callback.
 */
export function configureEditorTransformGizmo(transform: TransformControls): () => void {
  // World space keeps move and rotate aligned with the bed. Scale stays local in three-stdlib.
  transform.setSpace('world')

  const gizmo = (transform as unknown as { gizmo?: GizmoLayers }).gizmo
  if (!gizmo) return () => {}

  for (const layer of [gizmo.gizmo, gizmo.picker, gizmo.helper]) {
    for (const mode of ['translate', 'scale'] as const) {
      const group = layer?.[mode]
      if (!group) continue

      for (const handle of [...group.children]) {
        if (REMOVED_HANDLES[mode].has(handle.name)) group.remove(handle)
      }
    }
  }

  if (typeof gizmo.updateMatrixWorld !== 'function') return () => {}

  const libraryUpdate = gizmo.updateMatrixWorld
  gizmo.updateMatrixWorld = (force?: boolean) => {
    libraryUpdate.call(gizmo, force)
    pinTranslateHandles(gizmo)
  }

  return () => { gizmo.updateMatrixWorld = libraryUpdate }
}
