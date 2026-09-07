/**
 * Cut connectors: the pegs and holes that let two cut halves locate and hold together.
 *
 * Ports BambuStudio's `CutConnector` family (`Model.hpp:249-326`, the meshes in `Model.cpp:2049`,
 * and what each half receives in `CutUtils.cpp:142`). Pure geometry and rules: no scene, no React.
 *
 * **A connector is not a boolean.** Studio never subtracts it from the mesh. It adds the SAME shape
 * to both halves with different volume types -- a NEGATIVE_VOLUME on one side, a MODEL_PART on the
 * other -- and lets the slicer resolve them (`process_connector_cut`). We do the same through
 * `SceneEdit.addedParts`, which already carries per-part subtypes, so connectors need no CSG, no new
 * wire contract and no API surface: it is the path the cut already uses to carry helper volumes.
 *
 * Five rules that are easy to get wrong, each read out of the source rather than reasoned about:
 *
 *  - **Every base mesh is a UNIT shape scaled by `(radius, radius, height)`** (`Model.cpp:2106`) and
 *    `add_volume` CENTRES it on creation (`Model.cpp:1443`). Both facts are load-bearing below, and
 *    the second is invisible at the call site.
 *  - **A Prism dowel has its height DOUBLED** (`GLGizmoAdvancedCut.cpp:1390`). That reads as
 *    arbitrary until you see the meshes: the frustum dowel is a bipyramid spanning -1..+1, already
 *    two units tall, so the doubling is what makes the two STYLES the same length at one nominal
 *    height. Without it a Prism dowel is half the dowel a Frustum one is.
 *  - **A plug sits entirely on one side; a dowel straddles.** Studio shifts a non-dowel's centre by
 *    half its height along the plane normal (`:1393`) so its base lands on the cut plane, and leaves
 *    a dowel centred -- which is exactly why a dowel needs a hole in BOTH halves and a pin of its
 *    own, while a plug needs a hole in one and a peg on the other.
 *  - **Tolerance widens the HOLE, never the peg** (`CutUtils.cpp:19-45`). The negative volume is
 *    scaled up and the model part is left exact, so a joint is loose by what was asked for rather
 *    than by twice it. Same rule the dovetail's play follows.
 *  - **The tolerances are MILLIMETRES, despite the `[0.f : 1.f]` comment on the struct**, which is
 *    stale. `apply_tolerance` ADDS them to the scale factor, and since the mesh is unit-sized that
 *    factor IS the dimension in mm. The legacy ratio path survives only behind a `radius == 0` test
 *    marked "For compatibility with old files" (`Model.cpp:3327`). Reading them as ratios would make
 *    every hole 10cm oversized at the default 0.1.
 *
 * Studio's fourth type, Thread, is deliberately NOT ported. It is experimental in the vendored tree:
 * its generator is introduced as a "CUSTOM GENERATOR" and its cut branch as a "TRACER BULLET"
 * (`CutUtils.cpp:161`), its pitch is hardcoded relative to the UNIT mesh so the physical thread
 * stretches with the connector rather than holding a standard, and its male and female sides are the
 * same solid distinguished only by tolerance. There is no settled behaviour there to follow.
 *
 * Counterparts: `meshCut.ts` (the cut these attach to) and `CutToolPanel.tsx` (the controls).
 */
import type { CutAxis } from './meshCut'

/** Which fastening a connector is. Studio's `CutConnectorType`, less the experimental `Thread`. */
export type CutConnectorType = 'plug' | 'dowel' | 'snap'

/** Studio's `CutConnectorStyle`. Not a taper RATIO: it selects a different solid entirely. */
export type CutConnectorStyle = 'prism' | 'frustum'

/** Studio's `CutConnectorShape`. The name is the cross-section, not the solid. */
export type CutConnectorShape = 'triangle' | 'square' | 'hexagon' | 'circle'

/**
 * How many sides each connector profile has (`Model.cpp:2053`).
 *
 * The circle is 64, and NOT the 360 BambuStudio uses (`its_make_cylinder(1, 1, PI / 180)`; the 60
 * that also appears there is for its conflict-detection hull, a different job), because
 * the two tools do different things with the shape. Studio keeps a connector as a negative volume
 * and lets the slicer resolve it, so its cut face stays two triangles however fine the cylinder is.
 * Ours DRILLS the hole, so the face has to be re-tiled around every bore -- and at 360 sides the
 * boundary points of a 1.25mm hole are 0.02mm apart while the outer boundary is tens of millimetres
 * away, so the tiling is forced to emit slivers: measured on a three-connector cut, 77 of them, with
 * a worst aspect ratio of 6.8 million. A sliver's normal is the cross product of two nearly parallel
 * edges, which is numerically garbage, and it shades as a thin dark line across an otherwise flat
 * face. That is the artefact this number exists to avoid.
 *
 * 64 is where the slivers reach zero (measured: 77 -> 0, worst aspect 6.8M -> 7.2K, and 5.5x fewer
 * triangles). Going further to 32 brings them back, because the tiling coarsens faster than the
 * circle does. The cost is a chord error of 0.0015mm on the default radius -- two orders of
 * magnitude under a 0.4mm nozzle, and well under one layer -- so nothing printable changes.
 */
export const CONNECTOR_SHAPE_SIDES: Record<CutConnectorShape, number> = {
  triangle: 3,
  square: 4,
  hexagon: 6,
  circle: 64
}

/** One connector, positioned ON the cut plane in WORLD millimetres. */
export interface CutConnector {
  /** Stable identity for selection and removal; list position is not identity. */
  id: string
  x: number
  y: number
  z: number
  radius: number
  height: number
  /** Millimetres added to the HOLE's radius, never taken off the peg. */
  radiusTolerance: number
  /** Millimetres added to the HOLE's depth. */
  heightTolerance: number
  type: CutConnectorType
  style: CutConnectorStyle
  shape: CutConnectorShape
}

/**
 * What every connector on one cut is made to: a {@link CutConnector} without its identity or its
 * position. Held once per cut rather than per connector -- see `CutToolPanel` for why.
 */
export type ConnectorSettings = Omit<CutConnector, 'id' | 'x' | 'y' | 'z'>

/**
 * What the gizmo actually places (`GLGizmoAdvancedCut.hpp:169-173` + `:1985`), which is NOT the
 * `CutConnector` constructor's own defaults of radius 5 / height 10 -- Studio never uses those,
 * because it always passes explicit values. Note the UI's "Size" is a DIAMETER and the radius is
 * half of it, so 2.5mm of size is 1.25mm of radius.
 */
export const CONNECTOR_DEFAULTS = {
  radius: 1.25,
  height: 3,
  radiusTolerance: 0.1,
  heightTolerance: 0.1,
  type: 'plug',
  style: 'prism',
  shape: 'circle'
} as const satisfies ConnectorSettings

/**
 * What a connector's Size (diameter) and Depth may be, in mm, for a model of this size.
 *
 * A connector is a PEG through the cut face, so it is bounded by the part it has to fit inside:
 * the max is half the model's smallest dimension, which is the widest peg that still leaves
 * material around it on every side. This used to borrow the GROOVE range
 * (`grooveSizeLimitsForSize`, `min 1` and half the SUMMED dimensions), which describes a channel
 * across the whole part and is simply a different quantity: it offered 450mm of connector depth on
 * a 300mm model, and its `min: 1` sat above the 0.5mm a fine nozzle can still print.
 *
 * The floor keeps the defaults reachable whatever the model: a max below
 * {@link CONNECTOR_DEFAULTS} would clamp the values the tool opens with, so the user's first sight
 * of the panel would be numbers it had silently rewritten. A null/degenerate size (the first render,
 * before the cut-plane effect has measured the object) therefore yields a usable range rather than
 * the `{min: 1, max: 1}` that clamped Size to 1mm for anyone who touched the field early.
 */
export function connectorSizeLimitsForSize(size: { x: number; y: number; z: number } | null): { min: number; max: number } {
  const defaultMax = Math.max(CONNECTOR_DEFAULTS.radius * 2, CONNECTOR_DEFAULTS.height)
  if (!size) return { min: CONNECTOR_SIZE_MIN, max: defaultMax }
  const smallest = Math.min(size.x, size.y, size.z)
  if (!Number.isFinite(smallest) || smallest <= 0) return { min: CONNECTOR_SIZE_MIN, max: defaultMax }
  return { min: CONNECTOR_SIZE_MIN, max: Math.max(defaultMax, smallest / 2) }
}

/** Below this a peg is not printable on any nozzle this app targets. */
const CONNECTOR_SIZE_MIN = 0.5

/** Studio's `CutConnectorParas` (`Model.hpp:272`): the snap's slot and bulge, as fractions of radius. */
export const SNAP_SPACE_PROPORTION = 0.3
export const SNAP_BULGE_PROPORTION = 0.15

/** Stations per snap lobe arc (`its_make_snap`'s `sectors_cnt`); each arc emits `2 * this + 1`. */
const SNAP_SECTORS = 10

/**
 * The preview nudge Studio gives a plug's or snap's hole (`CutUtils.cpp:42`), so the negative volume
 * pokes slightly proud of the cut face rather than sharing a plane with it. Not merely cosmetic:
 * exactly-coplanar faces are what a slicer resolves inconsistently.
 */
const HOLE_PREVIEW_NUDGE = 0.05

/** What one connector contributes to each half of the cut. */
export interface ConnectorVolumes {
  /** Added to the half ABOVE the plane. */
  upper: { soup: Float32Array; subtype: 'negative_part' | 'normal_part' }
  /** Added to the half BELOW the plane. */
  lower: { soup: Float32Array; subtype: 'negative_part' | 'normal_part' }
  /**
   * A dowel is also printed as a loose PIN of its own, at exact size, and that is the thing that
   * ends up in both holes (`CutUtils.cpp:198`). Absent for a plug or a snap, which need no part.
   */
  pin?: Float32Array
}

/**
 * The volumes one connector adds to each half of the cut.
 *
 * Mirrors `process_connector_cut`. A plug leaves a hole above and a peg below. A snap does the same,
 * except its HOLE is a plain cylinder rather than the snap's own barbed outline
 * (`CutUtils.cpp:175`) -- which is the whole mechanism: the bulge compresses going in and springs
 * out past the lip. A dowel is a hole in both halves plus a separate pin.
 */
export function connectorVolumes(connector: CutConnector, axis: CutAxis): ConnectorVolumes {
  if (connector.type === 'dowel') {
    return {
      upper: { soup: placedSoup(connector, axis, { grown: true }), subtype: 'negative_part' },
      lower: { soup: placedSoup(connector, axis, { grown: true }), subtype: 'negative_part' },
      pin: placedSoup(connector, axis, { grown: false })
    }
  }
  // A snap's socket is a plain cylinder of the same footprint, not the snap outline.
  const hole: CutConnector = connector.type === 'snap'
    ? { ...connector, type: 'plug', shape: 'circle', style: 'prism' }
    : connector
  return {
    upper: { soup: placedSoup(hole, axis, { grown: true }), subtype: 'negative_part' },
    lower: { soup: placedSoup(connector, axis, { grown: false }), subtype: 'normal_part' }
  }
}

/**
 * The BORES one side of the cut receives: the connectors whose volume on that side is a hole.
 *
 * The one definition, because two callers must agree about it or the tool lies. The preview draws
 * "the face as the cut will leave it" and the cut drills that same face, so a connector counted as a
 * bore by one and not the other shows the user a face that disagrees with the geometry written --
 * with nothing failing. Each entry keeps its `connectorIndex`, since the filter drops the peg sides
 * and the caller still has to say WHICH connector a drilled hole belonged to.
 */
export function connectorBoresForSide(
  connectors: readonly CutConnector[],
  axis: CutAxis,
  side: 'upper' | 'lower'
): Array<{ connectorIndex: number; soup: Float32Array }> {
  return connectors.flatMap((connector, connectorIndex) => {
    const volumes = connectorVolumes(connector, axis)
    const here = side === 'upper' ? volumes.upper : volumes.lower
    return here.subtype === 'negative_part' ? [{ connectorIndex, soup: here.soup }] : []
  })
}

/**
 * One connector's world-space soup. `grown` applies the tolerances, which only a HOLE gets.
 *
 * Exported for the viewport marker, which draws the peg exactly as it will be made.
 */
export function connectorSoup(connector: CutConnector, axis: CutAxis, options: { grown: boolean }): Float32Array {
  return placedSoup(connector, axis, options)
}

function placedSoup(connector: CutConnector, axis: CutAxis, options: { grown: boolean }): Float32Array {
  const { grown } = options
  const straddle = connector.type === 'dowel'
  // A Prism dowel is doubled so it matches the bipyramid's own two-unit length.
  const nominalHeight = straddle && connector.style === 'prism' ? connector.height * 2 : connector.height
  const radius = grown ? connector.radius + connector.radiusTolerance : connector.radius
  const height = grown ? nominalHeight + connector.heightTolerance : nominalHeight

  const soup = connectorUnitSoup(connector.type, connector.style, connector.shape)
  scaleSoup(soup, radius, radius, height)

  // Studio's own offsets. Half the tolerance keeps the hole's MOUTH on the cut plane while the extra
  // depth goes into the material; a non-dowel additionally stands its base on the plane.
  let along = grown ? 0.5 * connector.heightTolerance : 0
  if (grown && !straddle) along -= HOLE_PREVIEW_NUDGE
  if (!straddle) along += 0.5 * height

  orientSoupToAxis(soup, axis)
  const shift = axisOffset(axis, along)
  translateSoup(soup, connector.x + shift.x, connector.y + shift.y, connector.z + shift.z)
  return soup
}

/**
 * The connector body as a UNIT solid: centred on the origin, +Z along the cut normal, unit radius.
 *
 * The centring is Studio's, applied by `add_volume` rather than by any builder, so the raw spans
 * differ between shapes (0..1 for most, -1..+1 for the bipyramid) and only the centred result is
 * comparable. Each builder also has its OWN starting angle, which is visible on a triangle or a
 * square, so the phases are reproduced rather than unified.
 */
export function connectorUnitSoup(
  type: CutConnectorType,
  style: CutConnectorStyle,
  shape: CutConnectorShape
): Float32Array {
  const sides = CONNECTOR_SHAPE_SIDES[shape]
  const soup = type === 'snap'
    ? snapSoup()
    : style === 'prism'
      ? prismSoup(sides)
      : type === 'plug'
        ? coneSoup(sides)
        : bipyramidSoup(sides)
  centerSoup(soup)
  return soup
}

/** `its_make_cylinder`: straight prism, z = 0..1, first vertex at +Y. */
function prismSoup(sides: number): Float32Array {
  const out: number[] = []
  const lower = ring(sides, 1, 0, Math.PI / 2)
  const upper = ring(sides, 1, 1, Math.PI / 2)
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    // Walls wound so the normal points AWAY from the axis. Reversed, a peg renders as an open tube:
    // backface culling hides the walls you should see and shows the ones you should not.
    pushTri(out, lower[i]!, lower[j]!, upper[j]!)
    pushTri(out, lower[i]!, upper[j]!, upper[i]!)
    pushTri(out, [0, 0, 0], lower[j]!, lower[i]!)
    pushTri(out, [0, 0, 1], upper[i]!, upper[j]!)
  }
  return new Float32Array(out)
}

/**
 * `its_make_cone`: base ring at z = 0, apex at z = 1, first vertex at +X. A true cone, not a
 * truncated one -- "Frustum" names the STYLE, and for a plug that style tapers all the way to a
 * point. There is no taper ratio anywhere in Studio's connector path.
 */
function coneSoup(sides: number): Float32Array {
  const out: number[] = []
  const base = ring(sides, 1, 0, 0)
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    // The side and the base must AGREE. They did not: the base faced -Z correctly while the sides
    // faced inward, so the solid had no consistent orientation at all and its signed volume came out
    // as zero, the two halves cancelling rather than merely being inside out.
    pushTri(out, base[i]!, base[j]!, [0, 0, 1])
    pushTri(out, [0, 0, 0], base[j]!, base[i]!)
  }
  return new Float32Array(out)
}

/**
 * `its_make_frustum_dowel`: despite the name, a BIPYRAMID spanning z = -1..+1, built from sphere
 * code with two stacks. Its equator carries a quarter-turn phase offset (`TriangleMesh.cpp:1162`),
 * which is what makes a square dowel sit axis-aligned where a square plug sits corner-up.
 */
function bipyramidSoup(sides: number): Float32Array {
  const out: number[] = []
  const equator = ring(sides, 1, 0, Math.PI / 4)
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides
    pushTri(out, equator[i]!, equator[j]!, [0, 0, 1])
    pushTri(out, equator[j]!, equator[i]!, [0, 0, -1])
  }
  return new Float32Array(out)
}

/**
 * `its_make_snap`: TWO springy lobes facing each other across a slot, each a barbed profile.
 *
 * Ported by shape rather than by index arithmetic -- the original stitches its facets through
 * offsets that only mean anything inside its own vertex layout, while the solid it describes is
 * three lofted profiles per lobe: full radius at the base, bulged at mid height, and half radius at
 * the top so it guides into the socket. The slot between the lobes is what lets the bulge compress.
 *
 * The bulge radius is NOT `1 + bulge_proportion`. That quantity only defines the flattening `f`; the
 * radius actually reached at the arc's centre is `(1 + 2b) / (1 + b)`, which is 1.1304 rather than
 * 1.15 at the default. Porting the nominal value instead would make every snap slightly too fat.
 */
function snapSoup(): Float32Array {
  const space = SNAP_SPACE_PROPORTION
  const bulge = SNAP_BULGE_PROPORTION
  const baseRadius = 1
  const topRadius = 0.5
  // Studio's `f`, the flattening of the mid-height ellipse. Negative, which is what makes the
  // radius GROW away from the chord rather than shrink.
  const flattening = (baseRadius - (1 + bulge)) / (1 + bulge)
  const oneMinusF = 1 - flattening
  const midRadiusAt = (angle: number): number => {
    const sinSq = Math.sin(angle) ** 2
    return Math.sqrt((baseRadius * baseRadius) / (1 + (1 / (oneMinusF * oneMinusF) - 1) * sinSq))
  }
  // Where each arc meets the flat chord. The top arc's `acos(2 * space)` is why Studio caps the gap
  // at 50%: beyond that the argument leaves [-1, 1] and the shape has no solution.
  const baseAngle = Math.acos(space / baseRadius)
  const topAngle = Math.acos(space / topRadius)

  const out: number[] = []
  for (const [centerX, rotation] of [[-space, Math.PI / 2], [space, 1.5 * Math.PI]] as const) {
    const base: [number, number, number][] = []
    const mid: [number, number, number][] = []
    const top: [number, number, number][] = []
    for (let k = 0; k <= 2 * SNAP_SECTORS; k++) {
      const b = rotation - baseAngle + (k * baseAngle) / SNAP_SECTORS
      const t = rotation - topAngle + (k * topAngle) / SNAP_SECTORS
      const m = midRadiusAt(b)
      // Studio's `Rotation2Df(theta) * (0, L)`, i.e. (-L sin, L cos).
      base.push([-baseRadius * Math.sin(b), baseRadius * Math.cos(b), 0])
      mid.push([-m * Math.sin(b), m * Math.cos(b), 0.5])
      top.push([-topRadius * Math.sin(t), topRadius * Math.cos(t), 1])
    }
    const bottomHub: [number, number, number] = [centerX, 0, 0]
    const topHub: [number, number, number] = [centerX, 0, 1]
    for (let k = 0; k < 2 * SNAP_SECTORS; k++) {
      const n = k + 1
      // Outer wall, base to bulge to tip.
      pushTri(out, base[k]!, mid[n]!, mid[k]!)
      pushTri(out, base[k]!, base[n]!, mid[n]!)
      pushTri(out, mid[k]!, top[n]!, top[k]!)
      pushTri(out, mid[k]!, mid[n]!, top[n]!)
      // The two end caps, fanned from the hub on the chord.
      pushTri(out, bottomHub, base[n]!, base[k]!)
      pushTri(out, topHub, top[k]!, top[n]!)
    }
    // The flat chord face at each end of the arc, closing the lobe against its slot.
    const last = 2 * SNAP_SECTORS
    // Both ends of the arc land on the SAME chord plane (`x = centerX`, which is what
    // `acos(space / radius)` buys), so both faces share one outward normal -- but they lie on
    // opposite sides of the hub in Y, so a fan from that shared hub walks them in opposite senses
    // and the second must be reversed. Winding the two alike leaves the lobe inconsistently
    // oriented, which renders as a shell you can see through, and no closedness test can catch it:
    // undirected edge pairing is just as happy with a flipped face. `orientationFaults` in the
    // tests is what does catch it.
    pushTri(out, bottomHub, base[0]!, mid[0]!)
    pushTri(out, bottomHub, mid[0]!, top[0]!)
    pushTri(out, bottomHub, top[0]!, topHub)
    pushTri(out, bottomHub, mid[last]!, base[last]!)
    pushTri(out, bottomHub, top[last]!, mid[last]!)
    pushTri(out, bottomHub, topHub, top[last]!)
  }
  return new Float32Array(out)
}

/**
 * `sides` points on a circle of `radius` at height `z`. `phase` is the builder's own starting angle,
 * measured from +X: Studio's cylinder starts at +Y, its cone at +X, and its bipyramid at +45.
 */
function ring(sides: number, radius: number, z: number, phase: number): [number, number, number][] {
  const points: [number, number, number][] = []
  for (let i = 0; i < sides; i++) {
    const angle = phase + (2 * Math.PI * i) / sides
    points.push([radius * Math.cos(angle), radius * Math.sin(angle), z])
  }
  return points
}

function pushTri(out: number[], a: readonly number[], b: readonly number[], c: readonly number[]): void {
  out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!)
}

function scaleSoup(soup: Float32Array, x: number, y: number, z: number): void {
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] = soup[i]! * x
    soup[i + 1] = soup[i + 1]! * y
    soup[i + 2] = soup[i + 2]! * z
  }
}

function translateSoup(soup: Float32Array, x: number, y: number, z: number): void {
  for (let i = 0; i < soup.length; i += 3) {
    soup[i] = soup[i]! + x
    soup[i + 1] = soup[i + 1]! + y
    soup[i + 2] = soup[i + 2]! + z
  }
}

/** Centre on the bounding box, as `ModelVolume::center_geometry_after_creation` does. */
function centerSoup(soup: Float32Array): void {
  if (soup.length === 0) return
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < soup.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = soup[i + a]!
      if (v < min[a]!) min[a] = v
      if (v > max[a]!) max[a] = v
    }
  }
  translateSoup(soup, -(min[0]! + max[0]!) / 2, -(min[1]! + max[1]!) / 2, -(min[2]! + max[2]!) / 2)
}

/**
 * Turn a +Z-built connector so its axis runs along the CUT axis. Exact coordinate swaps rather than
 * trig, for the same reason `orientCutHalfSoup` uses them: no float dirt before the weld, and
 * winding survives because each is a proper rotation.
 */
function orientSoupToAxis(soup: Float32Array, axis: CutAxis): void {
  if (axis === 'z') return
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i]!, y = soup[i + 1]!, z = soup[i + 2]!
    if (axis === 'x') {
      soup[i] = z // +90 about Y: +Z -> +X
      soup[i + 1] = y
      soup[i + 2] = -x
    } else {
      soup[i] = x // -90 about X: +Z -> +Y
      soup[i + 1] = z
      soup[i + 2] = -y
    }
  }
}

/** A displacement of `along` millimetres in the cut axis' own direction. */
function axisOffset(axis: CutAxis, along: number): { x: number; y: number; z: number } {
  if (axis === 'x') return { x: along, y: 0, z: 0 }
  if (axis === 'y') return { x: 0, y: along, z: 0 }
  return { x: 0, y: 0, z: along }
}

/**
 * Why a connector cannot be used. Studio's three, in the order its warning lists them
 * (`GLGizmoAdvancedCut.cpp:2953`).
 */
export type ConnectorProblem = 'outsideContour' | 'outsideObject' | 'overlaps'

/** Studio's own wording for each problem, singular and plural (`:2955-2963`). */
export const CONNECTOR_PROBLEM_TEXT: Record<ConnectorProblem, { one: string; many: string }> = {
  outsideContour: { one: 'connector is out of cut contour', many: 'connectors are out of cut contour' },
  outsideObject: { one: 'connector is out of object', many: 'connectors are out of object' },
  // Studio has no singular for this one; it always reads as a set.
  overlaps: { one: 'Some connectors are overlapped', many: 'Some connectors are overlapped' }
}

/**
 * Which connectors cannot be cut, keyed by id.
 *
 * Ports `is_conflict_for_connector` (`GLGizmoAdvancedCut.cpp:2069`), whose three tests gate Studio's
 * own Perform button: a connector must sit inside the cut cross-section, fit inside the object, and
 * not collide with another. The overlap test really is this crude upstream -- centre distance
 * against the sum of the radii, ignoring height and shape -- so it is ported rather than improved,
 * because a stricter rule would refuse layouts Studio accepts.
 *
 * `soup` is the object's world-space geometry, the same triangles the cut itself works on.
 */
export function findConnectorProblems(
  connectors: readonly CutConnector[],
  soup: Float32Array,
  /**
   * Containment override, so a caller can cache the one expensive test. `isPointInsideSoup` sweeps
   * EVERY triangle of the object, which is ~663k on a real model, and the contour rule runs it per
   * connector on every change -- placing the 20th connector would otherwise re-test all 20 against
   * the whole mesh, synchronously, inside a render.
   */
  isInside: (connector: CutConnector) => boolean = (connector) => isPointInsideSoup(soup, connector)
): Map<string, ConnectorProblem> {
  const problems = new Map<string, ConnectorProblem>()
  if (connectors.length === 0) return problems
  const box = soupBounds(soup)
  for (const connector of connectors) {
    // Cheapest first, and the one a user hits most: a click that landed off the cross-section.
    if (!isInside(connector)) {
      problems.set(connector.id, 'outsideContour')
      continue
    }
    const reach = connector.radius + connector.radiusTolerance
    const outside = connector.x - reach < box.min[0]! || connector.x + reach > box.max[0]!
      || connector.y - reach < box.min[1]! || connector.y + reach > box.max[1]!
      || connector.z - reach < box.min[2]! || connector.z + reach > box.max[2]!
    if (outside) {
      problems.set(connector.id, 'outsideObject')
      continue
    }
    for (const other of connectors) {
      if (other.id === connector.id) continue
      const gap = Math.hypot(connector.x - other.x, connector.y - other.y, connector.z - other.z)
      if (gap < connector.radius + other.radius) {
        problems.set(connector.id, 'overlaps')
        break
      }
    }
  }
  return problems
}

/**
 * A direction chosen for having no special relationship to anything: not axis-aligned, not in any
 * plane a printed model tends to have faces in, and with no two components in a simple ratio.
 *
 * That is the whole point. An axis-aligned ray is the obvious choice for an axis-aligned cut and it
 * is exactly the wrong one: a ray straight up the middle of a cube leaves through the shared
 * DIAGONAL of the two triangles making up its top face, so both count the crossing, parity flips,
 * and a point plainly inside the solid reports as outside. It is not a rare input either -- the
 * centre of any quad face is on that diagonal, and the centre is where a user aims. A generic
 * direction makes an exact edge hit measure-zero instead.
 */
const INSIDE_TEST_RAY = { x: 0.573_1, y: 0.421_7, z: 0.702_3 }

/**
 * Whether a point lies within the solid, by ray parity: an odd number of crossings means inside.
 *
 * This answers "is the click on the cross-section?" without building the cross-section, which the
 * cap code derives in a form keyed to capping rather than to hit-testing. Parity is exact for a
 * closed mesh, and on an open one it simply reports what the geometry actually encloses.
 */
export function isPointInsideSoup(soup: Float32Array, point: { x: number; y: number; z: number }): boolean {
  const { x: dx, y: dy, z: dz } = INSIDE_TEST_RAY
  let crossings = 0
  for (let o = 0; o + 8 < soup.length; o += 9) {
    // Moller-Trumbore, inlined against the fixed direction.
    const ax = soup[o]!, ay = soup[o + 1]!, az = soup[o + 2]!
    const e1x = soup[o + 3]! - ax, e1y = soup[o + 4]! - ay, e1z = soup[o + 5]! - az
    const e2x = soup[o + 6]! - ax, e2y = soup[o + 7]! - ay, e2z = soup[o + 8]! - az
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -1e-12 && det < 1e-12) continue
    const inv = 1 / det
    const tx = point.x - ax, ty = point.y - ay, tz = point.z - az
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) crossings++
  }
  return crossings % 2 === 1
}

function soupBounds(soup: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < soup.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const value = soup[i + a]!
      if (value < min[a]!) min[a] = value
      if (value > max[a]!) max[a] = value
    }
  }
  return { min, max }
}

/**
 * Studio's warning text for a set of problems, assembled the way it assembles it
 * (`render_input_window_warning`). Returns null when nothing is wrong.
 */
export function connectorProblemSummary(problems: ReadonlyMap<string, ConnectorProblem>): string | null {
  if (problems.size === 0) return null
  const counts = new Map<ConnectorProblem, number>()
  for (const problem of problems.values()) counts.set(problem, (counts.get(problem) ?? 0) + 1)
  const lines: string[] = []
  for (const problem of ['outsideContour', 'outsideObject', 'overlaps'] as const) {
    const count = counts.get(problem)
    if (!count) continue
    const text = CONNECTOR_PROBLEM_TEXT[problem]
    // The overlap message names no count upstream, so neither does ours.
    lines.push(problem === 'overlaps' ? text.one : `${count} ${count === 1 ? text.one : text.many}`)
  }
  return lines.join('; ')
}
