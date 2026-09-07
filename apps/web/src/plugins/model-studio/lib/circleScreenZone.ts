/**
 * Whether a hovered circle owns the measure cursor, and if so which part of it: ring or centre.
 *
 * Owns the rule that lets a hole's centre be selected with a pointer at all. The middle of a
 * through-hole is empty space, so a ray aimed there passes straight through and lands on whatever is
 * behind, which means the hover resolves to something else the instant the cursor leaves the ring and
 * a marker drawn at the centre is destroyed on the way to it. Deciding from the circle already
 * hovered removes that race: crossing the rim is what puts you in the hole.
 *
 * TWO tests, and both are needed. `circleScreenZone` says where the cursor is relative to the ring as
 * DRAWN, which is a screen question. `raySeesThroughCircle` says whether the cursor is looking
 * through the hole or at solid face, which is a depth one, and without it a round boss would claim
 * its whole top face; see that function for why projection alone cannot tell the two apart.
 *
 * Counterpart to `pickMeasureFeature` in `useEditorScene.ts`, which applies both before it resolves
 * anything from the model, and to `createMeasureFeatureHighlight` in `editorGeometry.ts`, which draws
 * the ring and the centre dot the zones correspond to. Neither test can serve a TAP, which has no
 * pointer history: on touch the centre is reached by raycasting the drawn marker instead.
 *
 * A deliberate divergence from BambuStudio, which only ever raycasts that marker; it can, because its
 * circle hover does not lapse the moment the ray misses.
 */
import * as THREE from 'three'

/** Client-space coordinates, matching what a `PointerEvent` reports. */
export interface ScreenPoint {
  x: number
  y: number
}

export type CircleScreenZone = 'ring' | 'interior' | null

/**
 * Below this projected radius a circle claims nothing, so it cannot swallow clicks aimed past it.
 *
 * Catches both the genuinely tiny circle and the edge-on one, which projects to a line.
 */
const MIN_TARGETABLE_RADIUS_PX = 3

/**
 * How much of the radius the ring may claim inward, leaving the rest to the centre.
 *
 * A fraction rather than a constant so both zones stay reachable at every size; see the comment at
 * the band itself for what a fixed reach does to a small hole.
 */
const RING_BAND_FRACTION = 0.4

/**
 * The zone a cursor sits in, or null when the circle claims neither.
 *
 * `project` maps a world point to client coordinates; `snapPx` is the same reach the rest of the
 * measure picking uses, applied here as the ring's half-thickness.
 *
 * The ring's radius is measured ALONG THE CURSOR'S OWN BEARING rather than taken from one rim
 * vertex, because a tilted circle projects to an ellipse: a single sample puts the boundary far
 * outside the ring across the long axis and inside the hole across the short one. A circle seen
 * edge-on collapses to a line and claims nothing, so it cannot swallow clicks aimed past it.
 */
export function circleScreenZone(
  circle: { center: THREE.Vector3; rim: readonly THREE.Vector3[] },
  cursor: ScreenPoint,
  /** Null for a point the camera cannot see, which the circle must not claim a region for. */
  project: (point: THREE.Vector3) => ScreenPoint | null,
  snapPx: number
): CircleScreenZone {
  const centre = project(circle.center)
  if (!centre) return null
  const toCursor = { x: cursor.x - centre.x, y: cursor.y - centre.y }
  const fromCentre = Math.hypot(toCursor.x, toCursor.y)

  let screenRadius = 0
  let widestSpoke = 0
  let bestAlignment = -Infinity
  for (const vertex of circle.rim) {
    const onScreen = project(vertex)
    if (!onScreen) continue
    const spoke = { x: onScreen.x - centre.x, y: onScreen.y - centre.y }
    const length = Math.hypot(spoke.x, spoke.y)
    if (length < 1e-6) continue
    widestSpoke = Math.max(widestSpoke, length)
    // Dead centre there is no bearing to match, so the widest spoke stands in: it is the only choice
    // that cannot report the cursor as OUTSIDE a ring it is exactly in the middle of.
    const alignment = fromCentre < 1e-6
      ? length
      : (spoke.x * toCursor.x + spoke.y * toCursor.y) / (length * fromCentre)
    if (alignment > bestAlignment) {
      bestAlignment = alignment
      screenRadius = length
    }
  }

  // Degeneracy is a property of the WHOLE circle, judged on its widest spoke rather than the one
  // under the cursor: an ellipse only a few pixels tall is still a ring worth grabbing along its
  // long axis, and testing the bearing radius here would drop it everywhere near the short one.
  if (widestSpoke < MIN_TARGETABLE_RADIUS_PX) return null
  // The grab band SHRINKS with the circle, because a fixed one is most of a small hole. At a 14px
  // reach a hole with a 16px radius would report its ring anywhere from 2px to 30px out and leave a
  // 2px centre, so the gesture the panel advertises would be unusable at any working zoom. Capped at
  // the caller's reach so a large bore does not get an absurdly thick ring instead.
  const band = Math.min(snapPx, screenRadius * RING_BAND_FRACTION)
  if (Math.abs(fromCentre - screenRadius) <= band) return 'ring'
  return fromCentre < screenRadius ? 'interior' : null
}

/**
 * Whether the ray reached PAST a circle's own plane, which is what separates looking THROUGH a hole
 * from looking at a solid round face.
 *
 * A projected disc alone cannot decide it. An outer silhouette is a circle too (`circlesAroundFace`:
 * "a round boss reads as a circle exactly as a bore does"), so claiming an interior on screen
 * position alone swallows the whole top face of any cylinder and every feature on it. Depth
 * distinguishes the two exactly, including under an oblique view where the projected ellipse laps
 * over solid face: inside a bore the ray reaches the far wall or nothing, which is behind the
 * circle's plane, while on the face it lands ON that plane and the face rightly wins. It also leaves
 * anything drawn in FRONT of a hole pickable through it.
 *
 * `hitDistance` is Infinity when the ray hit no geometry at all.
 */
export function raySeesThroughCircle(
  circle: { center: THREE.Vector3; normal: THREE.Vector3 },
  ray: THREE.Ray,
  hitDistance: number
): boolean {
  if (!Number.isFinite(hitDistance)) return true
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(circle.normal, circle.center)
  const planePoint = new THREE.Vector3()
  if (!ray.intersectPlane(plane, planePoint)) return false
  const toPlane = ray.origin.distanceTo(planePoint)
  // Scaled tolerance: when the hit IS the circle's own face the two distances are equal by
  // construction, and the float error in getting there grows with depth.
  return hitDistance > toPlane + Math.max(0.01, toPlane * 1e-4)
}
