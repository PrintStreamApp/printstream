/**
 * Keeps a two-finger pan from turning into an orbit when one finger lifts first.
 *
 * OrbitControls immediately reclassifies the remaining pointer as a one-finger rotate. On a
 * phone, the last finger almost always moves a few pixels while lifting, which makes the scene
 * swing around the panned target. Temporarily treating one finger as PAN until every pointer from
 * that gesture is up preserves intentional one-finger orbit for the next gesture.
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'

export function guardTouchOrbitTransition(
  element: HTMLElement,
  controls: Pick<OrbitControls, 'touches'>
): () => void {
  const activePointers = new Set<number>()
  const originalOneFingerAction = controls.touches.ONE
  let multiTouchGesture = false

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    activePointers.add(event.pointerId)
    if (activePointers.size < 2) return
    multiTouchGesture = true
    controls.touches.ONE = THREE.TOUCH.PAN
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    activePointers.delete(event.pointerId)
    if (!multiTouchGesture || activePointers.size > 0) return
    controls.touches.ONE = originalOneFingerAction
    multiTouchGesture = false
  }

  // Capture runs before OrbitControls' own bubble listeners. In particular, the first pointer-up
  // of a two-finger gesture must change ONE before OrbitControls reinitializes the remaining one.
  element.addEventListener('pointerdown', onPointerDown, true)
  element.addEventListener('pointerup', onPointerEnd, true)
  element.addEventListener('pointercancel', onPointerEnd, true)
  element.addEventListener('lostpointercapture', onPointerEnd, true)

  return () => {
    element.removeEventListener('pointerdown', onPointerDown, true)
    element.removeEventListener('pointerup', onPointerEnd, true)
    element.removeEventListener('pointercancel', onPointerEnd, true)
    element.removeEventListener('lostpointercapture', onPointerEnd, true)
    controls.touches.ONE = originalOneFingerAction
  }
}
