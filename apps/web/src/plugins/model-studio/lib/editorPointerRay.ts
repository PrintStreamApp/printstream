/**
 * Aim the editor viewport's shared raycaster at a canvas pointer position.
 * `useEditorScene` uses one ray for selection, tool hits, and bed-plane dragging; each caller must
 * leave it aimed at its current event before reading `raycaster.ray` or intersecting scene objects.
 */
import type * as THREE from 'three'

type PointerPosition = Pick<PointerEvent, 'clientX' | 'clientY'>

/** Update the shared normalized pointer and ray using the canvas's current viewport bounds. */
export function aimEditorPointerRay(
  canvas: HTMLCanvasElement,
  camera: THREE.PerspectiveCamera,
  pointer: THREE.Vector2,
  raycaster: THREE.Raycaster,
  event: PointerPosition
): void {
  const rect = canvas.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
}
