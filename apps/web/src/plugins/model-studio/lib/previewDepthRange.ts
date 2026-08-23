/**
 * Near/far plane fitting for the G-code preview's perspective camera.
 *
 * WHY THIS EXISTS. Depth precision in a perspective projection is governed almost entirely by the
 * NEAR plane, and it degrades with the square of the view distance. The G-code preview is the one
 * 3D surface here that renders with a LINEAR depth buffer: the editor and the plated 3MF preview
 * both enable `logarithmicDepthBuffer`, which is deliberately off here because it writes
 * `gl_FragDepth` and so disables early-Z rejection, a real per-fragment cost on a toolpath mesh of
 * millions of double-sided triangles. With a fixed `near = 0.1` and a `far` scaled to the content
 * (~10000 for a 350mm bed) the resolvable depth step at the framed distance works out around a
 * TENTH OF A MILLIMETRE, which is coarser than a 0.2mm layer and vastly coarser than the 0.01mm
 * the bed grid and the nozzle-only zones are lifted above the plate. Everything then z-fights: the
 * layer under a top surface punches through it, and the grid and zone overlays flicker against the
 * modelled build plate.
 *
 * Fitting the range to the content each frame is the fix that keeps early-Z: bracketing the scene
 * sphere instead of spanning 0.1-to-10000 buys several orders of magnitude of precision, more than
 * a logarithmic buffer would, at the cost of a few arithmetic ops per frame.
 *
 * Counterpart: `PreviewView.tsx`, which owns the camera and calls this before each draw. The
 * ORTHOGRAPHIC (3MF) branch does not need it, orthographic depth is uniform across the range.
 */

/** Never let the near plane reach zero, whatever the content: the projection divides by it. */
const ABSOLUTE_NEAR_FLOOR = 0.05

/**
 * The near plane as a fraction of the content radius, used only when the camera has dollied
 * INSIDE the content sphere and the geometric answer (`distance - radius`) goes negative. Keeps
 * the far/near ratio bounded (~400:1 at the surface) rather than letting it run away as the camera
 * approaches the model.
 */
const NEAR_FLOOR_RADIUS_FRACTION = 0.005

/**
 * The near plane as a fraction of the camera's own distance, which is what lets the user keep
 * zooming in once inside the content sphere.
 *
 * The radius floor above is a CONTENT-sized constant, so on a 350mm plate it pins the near plane at
 * ~1.3mm however close the camera gets. Dollying nearer than that puts the camera inside its own
 * near plane: the toolpaths vanish and zooming appears to stop working (reported as "zooming is
 * less and less effective until it does nothing"). The controls were never stuck: the distance
 * keeps halving, there is just nothing left un-clipped to see. Taking the SMALLER of the two floors
 * means the radius floor still governs at normal viewing distances (unchanged precision there) and
 * the distance floor takes over exactly when the camera closes in, so individual extrusions stay
 * inspectable.
 */
const NEAR_FLOOR_DISTANCE_FRACTION = 0.02

/**
 * Planes that bracket a sphere of `radius` centred on the origin, given the camera's distance from
 * that centre. Both inputs are in scene units (mm).
 *
 * Clamped rather than exact: a camera inside the sphere would otherwise ask for a negative near,
 * and content can extend slightly past the cached radius between loads, so `far` keeps a whole
 * radius of slack behind the centre.
 */
export function fitPerspectiveDepthRange(distance: number, radius: number): { near: number; far: number } {
  // Non-finite inputs are coerced, not trusted: `Math.max(NaN, x)` is NaN, and a NaN plane makes
  // the projection matrix singular: the canvas renders nothing, with no error anywhere.
  const safeRadius = Number.isFinite(radius) ? Math.max(radius, 1) : 1
  const safeDistance = Number.isFinite(distance) ? Math.max(distance, 0) : 0
  // The floor is the tighter of the two: content-sized while the camera is far enough away for it
  // to be the binding one, distance-sized once the camera is close (which is what keeps the near
  // plane in front of the camera instead of behind it).
  const insideFloor = Math.min(
    safeRadius * NEAR_FLOOR_RADIUS_FRACTION,
    safeDistance * NEAR_FLOOR_DISTANCE_FRACTION
  )
  const near = Math.max(safeDistance - safeRadius, insideFloor, ABSOLUTE_NEAR_FLOOR)
  // `near + safeRadius` only matters in the degenerate case where the distance is ~0; otherwise the
  // back of the sphere dominates. Keep it tight, every unit of unused far range costs precision.
  const far = Math.max(safeDistance + safeRadius, near + safeRadius)
  return { near, far }
}
