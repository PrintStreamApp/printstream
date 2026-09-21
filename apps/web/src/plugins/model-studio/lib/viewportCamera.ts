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
 * {@link ViewportCameraRig.groundPivot} chooses between two useful orbit targets once per rotate
 * gesture. When the whole bed is comfortably visible, the bed is the subject and rotation moves
 * the camera around its centre WITHOUT pulling that centre to the middle of the screen. Once the
 * user has zoomed into a detail, the subject is the area under the middle of the view; that point
 * is projected onto the bed plane and clamped to its footprint.
 * Without this policy the pivot is wherever zoom-to-cursor or panning last left it, and either can
 * leave the model swinging around a point floating in space or beyond a corner of the bed.
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
 * In close-up, staying ON the view axis makes the re-seat invisible: the ray through the middle of
 * the viewport IS the camera's forward axis, so the new pivot is already dead ahead and
 * re-targeting cannot rotate anything, only change the orbit RADIUS. (Studio flattens to `z = 0`
 * regardless, which it can afford because `rotate_on_sphere_with_target` carries its own
 * orientation.)
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
/**
 * Maximum projected bed span (NDC is 2 units across the viewport) that still reads as an
 * overview. The remaining 20% is breathing room around the bed, split across both sides.
 */
export const ORBIT_OVERVIEW_MAX_NDC_SPAN = 1.6
/** Quiet period after pointer-up that marks the end of OrbitControls' damping tail. */
export const ORBIT_DAMPING_SETTLE_MS = 160

/** The printable footprint that bounds a useful orbit pivot. */
export interface OrbitPivotBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** Live plate context read when a rotate gesture actually begins. */
export interface OrbitPivotContext {
  planeZ: number
  bounds: OrbitPivotBounds
}

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
  /** Whether the bed is currently framed as a whole subject rather than a zoomed detail. */
  isOverview(planeZ: number, bounds: OrbitPivotBounds): boolean
  /** Begin/end an overview orbit that preserves the bed's current screen position. */
  beginInPlaceOrbit(pivot: THREE.Vector3): void
  /** Keep correcting through the damping tail, then end after the controls settle. */
  finishInPlaceOrbit(): void
  /** End immediately because another gesture type has taken control. */
  endInPlaceOrbit(): void
  /**
   * Re-seat the pivot on `planeZ` under the middle of the view. No-op when the camera is too level
   * to meet the plane usefully, or when the meeting point is absurdly far.
   */
  groundPivot(planeZ: number, bounds?: OrbitPivotBounds): void
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

interface InPlaceOrbitFrame {
  readonly pivot: THREE.Vector3
  /** Pivot position in camera space at gesture start, including depth/apparent scale. */
  readonly cameraSpacePosition: THREE.Vector3
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
  let inPlaceOrbit: InPlaceOrbitFrame | null = null
  let inPlaceOrbitEndTimer: ReturnType<typeof setTimeout> | null = null
  const tweenTarget = new THREE.Vector3()
  const viewAxis = new THREE.Vector3()
  const inPlacePivotOffset = new THREE.Vector3()
  const inPlaceDesiredCameraPosition = new THREE.Vector3()
  const inPlaceCorrection = new THREE.Vector3()

  /**
   * OrbitControls always keeps its target in the middle of the screen. During an overview orbit,
   * place the camera so the bed centre retains its full camera-space position from gesture start.
   * Preserving X/Y keeps an off-centre bed exactly where the user put it; preserving Z keeps its
   * perspective scale, so rotation cannot quietly dolly the view closer or farther. This remains
   * stable across OrbitControls' world-up correction, whereas accumulating quaternion deltas
   * eventually drifts when the camera crosses an axis.
   */
  const preserveOverviewComposition = () => {
    if (!inPlaceOrbit) return
    if (inPlaceOrbitEndTimer) {
      clearTimeout(inPlaceOrbitEndTimer)
      inPlaceOrbitEndTimer = setTimeout(endInPlaceOrbitNow, ORBIT_DAMPING_SETTLE_MS)
    }
    camera.updateMatrixWorld(true)
    inPlacePivotOffset.copy(inPlaceOrbit.cameraSpacePosition).applyQuaternion(camera.quaternion)
    inPlaceDesiredCameraPosition.copy(inPlaceOrbit.pivot).sub(inPlacePivotOffset)
    inPlaceCorrection.copy(inPlaceDesiredCameraPosition).sub(camera.position)
    camera.position.add(inPlaceCorrection)
    controls.target.add(inPlaceCorrection)
    camera.updateMatrixWorld(true)
  }

  const endInPlaceOrbitNow = () => {
    if (inPlaceOrbitEndTimer) clearTimeout(inPlaceOrbitEndTimer)
    inPlaceOrbitEndTimer = null
    inPlaceOrbit = null
  }

  const cancel = () => { tween = null }
  // `start` rather than a pointerdown listener: it covers the wheel too, and a zoom made mid-swing
  // would otherwise be overwritten on the very next frame.
  controls.addEventListener('start', cancel)
  controls.addEventListener('change', preserveOverviewComposition)

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

    isOverview(planeZ: number, bounds: OrbitPivotBounds) {
      return bedFitsComfortablyInView(camera, bounds, planeZ)
    },

    beginInPlaceOrbit(pivot: THREE.Vector3) {
      if (inPlaceOrbitEndTimer) clearTimeout(inPlaceOrbitEndTimer)
      inPlaceOrbitEndTimer = null
      camera.updateMatrixWorld(true)
      inPlaceOrbit = {
        pivot: pivot.clone(),
        cameraSpacePosition: pivot.clone().applyMatrix4(camera.matrixWorldInverse)
      }
    },

    finishInPlaceOrbit() {
      if (!inPlaceOrbit) return
      if (inPlaceOrbitEndTimer) clearTimeout(inPlaceOrbitEndTimer)
      inPlaceOrbitEndTimer = setTimeout(endInPlaceOrbitNow, ORBIT_DAMPING_SETTLE_MS)
    },

    endInPlaceOrbit() {
      endInPlaceOrbitNow()
    },

    groundPivot(planeZ: number, bounds?: OrbitPivotBounds) {
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
      if (bounds) constrainPivotToBounds(controls.target, bounds)
    },

    dispose() {
      controls.removeEventListener('start', cancel)
      controls.removeEventListener('change', preserveOverviewComposition)
      endInPlaceOrbitNow()
      cancel()
    }
  }
}

/**
 * Install the rotate-start policy shared by editor and preview canvases.
 *
 * Touch waits until the first one-finger MOVE before choosing overview or detail behavior. A
 * second finger arriving first marks the entire gesture as pan/dolly, so beginning a two-finger
 * pan cannot rewrite the later orbit pivot. Capture-phase move runs before OrbitControls consumes
 * that first rotation delta.
 */
export function installOrbitPivotBehavior(
  element: HTMLElement,
  controls: Pick<OrbitControls, 'enabled'>,
  rig: Pick<
    ViewportCameraRig,
    'groundPivot' | 'isOverview' | 'beginInPlaceOrbit' | 'finishInPlaceOrbit' | 'endInPlaceOrbit'
  >,
  getContext: () => OrbitPivotContext | null
): () => void {
  const activeTouches = new Set<number>()
  let multiTouchGesture = false
  let touchGrounded = false
  const gestureTarget: Pick<HTMLElement, 'addEventListener' | 'removeEventListener'> = element.ownerDocument ?? element

  const beginOrbit = () => {
    if (!controls.enabled) {
      rig.endInPlaceOrbit()
      return
    }
    const context = getContext()
    if (!context) {
      rig.endInPlaceOrbit()
      return
    }
    if (rig.isOverview(context.planeZ, context.bounds)) {
      rig.beginInPlaceOrbit(new THREE.Vector3(
        (context.bounds.minX + context.bounds.maxX) / 2,
        (context.bounds.minY + context.bounds.maxY) / 2,
        context.planeZ
      ))
      return
    }
    rig.endInPlaceOrbit()
    rig.groundPivot(context.planeZ, context.bounds)
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      if (activeTouches.size === 0) {
        multiTouchGesture = false
        touchGrounded = false
      }
      activeTouches.add(event.pointerId)
      if (activeTouches.size > 1) {
        multiTouchGesture = true
        rig.endInPlaceOrbit()
      }
      return
    }
    // OrbitControls maps modified left-drag and the other mouse buttons to pan/dolly. End any
    // overview tail before those gestures so composition correction cannot fight an intentional
    // pan that starts immediately after rotation.
    if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) beginOrbit()
    else rig.endInPlaceOrbit()
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !activeTouches.has(event.pointerId)) return
    if (activeTouches.size !== 1 || multiTouchGesture || touchGrounded) return
    beginOrbit()
    touchGrounded = true
  }

  const onPointerEnd = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      rig.finishInPlaceOrbit()
      return
    }
    activeTouches.delete(event.pointerId)
    if (activeTouches.size === 0) {
      multiTouchGesture = false
      touchGrounded = false
      rig.finishInPlaceOrbit()
    }
  }

  // Wheel zoom is a different gesture and must not be mistaken for the tail of an overview orbit.
  // Capture runs before OrbitControls' own wheel handler mutates the camera.
  const onWheel = () => rig.endInPlaceOrbit()

  element.addEventListener('pointerdown', onPointerDown)
  element.addEventListener('wheel', onWheel, true)
  gestureTarget.addEventListener('pointermove', onPointerMove as EventListener, true)
  gestureTarget.addEventListener('pointerup', onPointerEnd as EventListener)
  gestureTarget.addEventListener('pointercancel', onPointerEnd as EventListener)

  return () => {
    rig.endInPlaceOrbit()
    element.removeEventListener('pointerdown', onPointerDown)
    element.removeEventListener('wheel', onWheel, true)
    gestureTarget.removeEventListener('pointermove', onPointerMove as EventListener, true)
    gestureTarget.removeEventListener('pointerup', onPointerEnd as EventListener)
    gestureTarget.removeEventListener('pointercancel', onPointerEnd as EventListener)
  }
}

/**
 * Whether the bed is small enough on screen that rotation should treat it as one whole subject.
 * Projected SIZE is intentional rather than containment: panning does not turn an overview into a
 * close-up, while zooming does. The bounds come from the active printer, never a standard-bed
 * assumption.
 */
export function bedFitsComfortablyInView(
  camera: THREE.Camera,
  bounds: OrbitPivotBounds,
  planeZ: number
): boolean {
  camera.updateMatrixWorld(true)
  const minX = Math.min(bounds.minX, bounds.maxX)
  const maxX = Math.max(bounds.minX, bounds.maxX)
  const minY = Math.min(bounds.minY, bounds.maxY)
  const maxY = Math.max(bounds.minY, bounds.maxY)
  let projectedMinX = Infinity
  let projectedMaxX = -Infinity
  let projectedMinY = Infinity
  let projectedMaxY = -Infinity

  for (const [x, y] of [[minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]]) {
    const corner = new THREE.Vector3(x, y, planeZ)
    const cameraSpace = corner.clone().applyMatrix4(camera.matrixWorldInverse)
    // A corner on/behind the eye cannot describe a useful overview.
    if (!Number.isFinite(cameraSpace.z) || cameraSpace.z >= 0) return false
    corner.project(camera)
    if (!Number.isFinite(corner.x) || !Number.isFinite(corner.y)) return false
    projectedMinX = Math.min(projectedMinX, corner.x)
    projectedMaxX = Math.max(projectedMaxX, corner.x)
    projectedMinY = Math.min(projectedMinY, corner.y)
    projectedMaxY = Math.max(projectedMaxY, corner.y)
  }

  return projectedMaxX - projectedMinX <= ORBIT_OVERVIEW_MAX_NDC_SPAN
    && projectedMaxY - projectedMinY <= ORBIT_OVERVIEW_MAX_NDC_SPAN
}

/** Keep a close-up pivot on the printable footprint even when the view centre has drifted past it. */
export function constrainPivotToBounds(pivot: THREE.Vector3, bounds: OrbitPivotBounds): THREE.Vector3 {
  pivot.x = THREE.MathUtils.clamp(pivot.x, Math.min(bounds.minX, bounds.maxX), Math.max(bounds.minX, bounds.maxX))
  pivot.y = THREE.MathUtils.clamp(pivot.y, Math.min(bounds.minY, bounds.maxY), Math.max(bounds.minY, bounds.maxY))
  return pivot
}

/** Wall clock for the tween. Split out so a test can drive `advance` without one. */
function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
