/**
 * How a 3D viewport's camera MOVES: the animated swing to a view, and where a rotate pivots.
 *
 * OWNS both behaviours for every viewport in the plugin -- the editor and the read-only previews
 * (model and sliced G-code) -- because they are one control scheme and were briefly two. The view
 * cube is shared through `viewCube.ts`, so both surfaces grew the same regions, modifiers and hint,
 * while the editor alone learned to animate and to pivot sensibly; the previews kept snapping. A
 * second copy is how the two would drift again, so there is one.
 *
 * ## The swing
 *
 * Interpolates the whole camera ORIENTATION and derives the position from it, rather than
 * interpolating the direction and letting `lookAt` rebuild the roll each frame. The latter is
 * smooth across the middle of the sphere and violent at the poles, where a fractional change of
 * direction swings the up vector through a large angle and the camera appears to snap round
 * mid-flight -- worst going from Top to Bottom, which are exactly antipodal. Deriving the position
 * from the orientation also means the camera faces the target at a constant radius the whole way,
 * with no separate positional interpolation that could disagree and make the model loom.
 *
 * `advance` must run BEFORE `OrbitControls.update()`, and the caller must SKIP that update while a
 * swing is in flight: `update()` ends in `lookAt(target)`, which would recompute the roll from the
 * direction every frame and undo the interpolation. The swing lands on exactly the orientation
 * `lookAt` would produce, so the controls pick up seamlessly on the first frame after it finishes.
 *
 * Any camera gesture cancels a swing outright. The hook is `OrbitControls`' own `start` event
 * because that covers the WHEEL as well as a drag; a `pointerdown` listener would miss the wheel
 * and the swing would overwrite the zoom every frame.
 *
 * ## The pivot
 *
 * {@link ViewportCameraRig.groundPivot} re-seats the orbit target on a horizontal plane under the
 * middle of the view, once per rotate gesture. Without it the pivot is wherever panning last left
 * the target, and panning moves it in the SCREEN plane -- so on a tilted camera every vertical pan
 * lifts it off the plate, and the model then swings wide around a point floating in space.
 *
 * Ports the pivot BambuStudio computes for a Ctrl-rotate (`GLCanvas3D.cpp:5941`): the point under
 * the screen centre, resolved when the drag starts and held for its duration. One deliberate
 * divergence -- Studio makes this the CTRL gesture and orbits the plate's bounding-box centre by
 * default, which is the behaviour being replaced, so ours is the plain drag.
 *
 * It seats the pivot on a PLANE, deliberately not on the geometry under the cursor, which is what
 * it did first and which drifts: a surface hit is not idempotent, so orbiting a few degrees makes
 * the same ray meet the model at a different depth and the pivot creeps with every drag. A plane
 * hit IS idempotent -- once the pivot is on the plane and the camera looks at it, the ray meets the
 * plane at exactly that point again. Use the SAME plane the viewport frames on, or the first drag
 * after a reframe slides the pivot along the view axis to reach a different height, which reads as
 * the centre of rotation jumping away from the middle of the plate.
 *
 * Staying ON the view axis is what makes the re-seat invisible: the ray through the middle of the
 * viewport IS the camera's forward axis, so the new pivot is already dead ahead and re-targeting
 * cannot rotate anything, only change the orbit RADIUS. (Studio flattens to `z = 0` regardless,
 * which it can afford because `rotate_on_sphere_with_target` carries its own orientation.)
 */
import * as THREE from 'three'
import type { OrbitControls } from 'three-stdlib'
import { easeViewTween, viewOrientationFor, viewPositionFor, viewTweenOrientationAt } from './viewCube'

/**
 * How long the camera takes to swing to a view. Short enough to feel like a response rather than a
 * cutscene, long enough that the eye can follow which way the model turned, which is the whole
 * point: a snap leaves you re-reading the scene to work out where you ended up.
 */
export const VIEW_TWEEN_MS = 260
/** Below this the swing is imperceptible and animating it only adds latency. */
export const VIEW_TWEEN_MIN_ANGLE = 0.02
/**
 * How level the camera may get before a plane stops being a usable pivot. At a grazing angle the
 * view axis meets it far past the plate, and orbiting a point out there reads as panning.
 */
export const ORBIT_PIVOT_MIN_AXIS_TILT = 0.08
/** Multiples of the current pivot distance a new pivot may sit at before the old one is kept. */
export const ORBIT_PIVOT_MAX_REACH = 8

/** Where a swing should end up. */
export interface ViewportCameraDestination {
  /** Offset from the target to the camera. Normalized internally; length is ignored. */
  direction: { x: number; y: number; z: number }
  /** Point to look at. Omit to keep the current pivot. */
  target?: THREE.Vector3
  /** Distance to hold from the target. Omit to keep the current one. */
  distance?: number
}

export interface ViewportCameraRig {
  /**
   * Swing to a destination, or snap when there is nothing to animate.
   *
   * Snapping matters: a swing to where the camera already is would otherwise spend its whole
   * duration changing nothing, which reads as a delay rather than as a no-op.
   */
  swingTo(destination: ViewportCameraDestination): void
  /**
   * Advance an in-flight swing. Returns true while it still has frames to paint, which is what the
   * caller uses BOTH to keep an on-demand render loop awake and to skip `controls.update()`.
   */
  advance(now: number): boolean
  /** Stop steering the camera; the user has taken it. */
  cancel(): void
  /**
   * Re-seat the pivot on `planeZ` under the middle of the view. No-op when the camera is too level
   * to meet the plane usefully, or when the meeting point is absurdly far.
   */
  groundPivot(planeZ: number): void
  /** Remove the gesture listener. The camera and controls are the caller's to dispose. */
  dispose(): void
}

interface ViewTween {
  readonly fromOrientation: THREE.Quaternion
  readonly toOrientation: THREE.Quaternion
  readonly fromTarget: THREE.Vector3
  readonly toTarget: THREE.Vector3
  readonly fromDistance: number
  readonly toDistance: number
  readonly startedAt: number
}

/**
 * Build the rig for one viewport.
 *
 * `onChange` is called on every frame a swing moves the camera, so an on-demand renderer can mark
 * itself dirty; a viewport that renders every frame can leave it out.
 */
export function createViewportCameraRig(
  camera: THREE.Camera,
  controls: OrbitControls,
  onChange?: () => void
): ViewportCameraRig {
  let tween: ViewTween | null = null
  const tweenTarget = new THREE.Vector3()
  const viewAxis = new THREE.Vector3()

  const cancel = () => { tween = null }
  // `start` rather than a pointerdown listener: it covers the wheel too, and a zoom made mid-swing
  // would otherwise be overwritten on the very next frame.
  controls.addEventListener('start', cancel)

  return {
    swingTo({ direction, target, distance }) {
      const toTarget = target ? target.clone() : controls.target.clone()
      const fromTarget = controls.target.clone()
      const fromDistance = camera.position.distanceTo(fromTarget) || 1
      const toDistance = distance ?? fromDistance
      const toOrientation = viewOrientationFor(direction)
      const fromOrientation = camera.quaternion.clone()
      camera.up.set(0, 0, 1)

      // Nothing to animate: already pointing this way, from this pivot, at this distance. The angle
      // test also covers the degenerate start where the camera sits on its own pivot and so has no
      // direction to swing FROM.
      const turn = fromOrientation.angleTo(toOrientation)
      const moved = fromTarget.distanceTo(toTarget) > 0.01 || Math.abs(fromDistance - toDistance) > 0.01
      if (turn < VIEW_TWEEN_MIN_ANGLE && !moved) {
        cancel()
        camera.quaternion.copy(toOrientation)
        camera.position.copy(viewPositionFor(toOrientation, toTarget, toDistance))
        controls.target.copy(toTarget)
        controls.update()
        return
      }
      tween = { fromOrientation, toOrientation, fromTarget, toTarget, fromDistance, toDistance, startedAt: now() }
      onChange?.()
    },

    advance(at: number) {
      if (!tween) return false
      const progress = Math.min(1, (at - tween.startedAt) / VIEW_TWEEN_MS)
      const orientation = viewTweenOrientationAt(tween.fromOrientation, tween.toOrientation, progress)
      // The pan and the zoom ride the SAME eased curve as the turn, so a reframing swing is one
      // motion rather than a turn with a separate lurch toward the middle inside it.
      const eased = easeViewTween(progress)
      tweenTarget.copy(tween.fromTarget).lerp(tween.toTarget, eased)
      const distance = tween.fromDistance + (tween.toDistance - tween.fromDistance) * eased
      // The orientation drives the position, never the other way round, and `lookAt` is NOT called:
      // recomputing the roll from the direction is exactly what made the swing snap at the poles.
      camera.quaternion.copy(orientation)
      camera.position.copy(viewPositionFor(orientation, tweenTarget, distance))
      // Carried on the controls too, so when the swing ends they are already orbiting the new pivot.
      controls.target.copy(tweenTarget)
      if (progress >= 1) tween = null
      onChange?.()
      return true
    },

    cancel,

    groundPivot(planeZ: number) {
      camera.getWorldDirection(viewAxis)
      // A camera looking level or upward never meets the plane; leave the pivot alone rather than
      // throwing it out to the horizon.
      if (Math.abs(viewAxis.z) < ORBIT_PIVOT_MIN_AXIS_TILT) return
      const distance = (planeZ - camera.position.z) / viewAxis.z
      if (distance <= 0) return
      // A grazing view meets the plane a long way off, where orbiting reads as panning. Past this
      // the old pivot is the better answer.
      if (distance > camera.position.distanceTo(controls.target) * ORBIT_PIVOT_MAX_REACH) return
      controls.target.copy(camera.position).addScaledVector(viewAxis, distance)
    },

    dispose() {
      controls.removeEventListener('start', cancel)
      cancel()
    }
  }
}

/** Wall clock for the tween. Split out so a test can drive `advance` without one. */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
