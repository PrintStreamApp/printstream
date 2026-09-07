/**
 * The distance and angle between two measurable features: BambuStudio's `Measure::get_measurement`.
 *
 * `measureFeatures.ts` decides WHAT is under the cursor; this module answers what the two things the
 * user picked measure. Ported pair by pair from `Measure.cpp:836-1299`, including the parts that are
 * surprising, because parity is the point -- a number that differs from Studio's by a millimetre is
 * worse than no number, since nothing on screen says which of the two is right.
 *
 * THE ARGUMENT ORDER IS CANONICALISED, exactly as Studio does it (`:840`). Features are ordered
 * Point < Edge < Circle < Plane, so only the upper triangle of the pair table needs writing, and the
 * `from`/`to` anchors are swapped back at the end (`:1286`) so they still describe the caller's own
 * argument order. Only those anchors are swapped: not `dist`, not the angle's edges.
 *
 * A CIRCLE ANSWERS FROM ITS RIM, everywhere and unconditionally. Studio carries a
 * `deal_circle_result` flag that its GUI hard-codes true (`:1226`), re-anchoring every circle answer
 * onto the centre; we have no equivalent, because the centre is separately selectable in this editor
 * (clicking inside the ring picks it as a point) and both questions therefore stay askable. Under
 * Studio's flag they are not: it is why its own "Center of circle" control changes no number.
 *
 * WHAT IS DELIBERATELY NOT PORTED. Studio computes circle-to-circle distance with a degree-8
 * polynomial solve (`DistCircle3Circle3`, ~200 lines plus a root finder) and then throws the answer
 * away on every call its GUI makes. Ours reports the shortest span between the two DETECTED rims
 * instead, which is simpler and truer about the part, since those vertices are the geometry that
 * prints.
 */
import * as THREE from 'three'
import type { MeasureFeature, MeshCircle } from './measureFeatures'

/** Studio's `EPSILON` (`libslic3r.h:52`), used for every parallel/perpendicular/coplanar test. */
const EPSILON = 1e-4

/**
 * Type ORDER, which is what the canonicalising swap compares (`Measure.cpp:840`).
 *
 * The numbers are Studio's own enum values (`Measure.hpp:20`), a bit field it happens to order by.
 * Only the relative order matters here, but keeping the values makes the comparison read the same.
 */
const FEATURE_ORDER: Record<MeasureFeature['kind'], number> = { point: 1, edge: 2, circle: 4, plane: 8 }

/** A measured distance and the two points it spans, which is what the overlay draws between. */
export interface DistAndPoints {
  dist: number
  from: THREE.Vector3
  to: THREE.Vector3
}

/** A measured angle and everything needed to draw its arc. */
export interface AngleAndEdges {
  /** RADIANS, always in [0, PI]. */
  angle: number
  /** Apex of the arc: where the two edges, extended, meet. */
  center: THREE.Vector3
  /** The two edges the arc spans, each reoriented so `[0]` is the end nearer {@link center}. */
  e1: [THREE.Vector3, THREE.Vector3]
  e2: [THREE.Vector3, THREE.Vector3]
  radius: number
  /** Whether the two edges genuinely share a plane. Rendering only. */
  coplanar: boolean
}

/**
 * What a measurement produced. Every field is optional and which ones appear is per PAIR, not a
 * matter of taste -- see the table in {@link getMeasurement}.
 */
export interface MeasurementResult {
  angle?: AngleAndEdges
  /** Distance to the INFINITE extension of the feature (a line, a plane). */
  distanceInfinite?: DistAndPoints
  /** Distance to the feature as it actually is, bounded by its endpoints or rim. */
  distanceStrict?: DistAndPoints
  /** Per-axis signed delta. Studio sets this for Point-Point only; see {@link measurementXyzDelta}. */
  distanceXyz?: THREE.Vector3
}

/**
 * Studio's `AngleAndEdges::Dummy` (`Measure.cpp:681`), returned for a pair whose angle is degenerate.
 *
 * NOT a "no angle" sentinel: Studio returns it INTO an optional, so the caller sees an angle that is
 * present and zero. Surfaces that ask "is there an angle" must therefore test the value, not the
 * presence, or two parallel edges report a confident 0 degrees.
 */
export const DUMMY_ANGLE: AngleAndEdges = {
  angle: 0,
  center: new THREE.Vector3(),
  e1: [new THREE.Vector3(), new THREE.Vector3()],
  e2: [new THREE.Vector3(), new THREE.Vector3()],
  radius: 0,
  coplanar: true
}

// ---- primitives Eigen gives Studio and three.js does not -----------------------------------------

const direction = (from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 =>
  new THREE.Vector3().subVectors(to, from).normalize()

/** Sign-INSENSITIVE, so antiparallel counts as parallel. Both inputs must be unit length. */
const areParallel = (a: THREE.Vector3, b: THREE.Vector3): boolean => Math.abs(Math.abs(a.dot(b)) - 1) < EPSILON
const arePerpendicular = (a: THREE.Vector3, b: THREE.Vector3): boolean => Math.abs(a.dot(b)) < EPSILON

/**
 * Eigen's `isApprox`, which is RELATIVE rather than absolute: at the origin it is exact equality.
 * Studio leans on that in Point-Circle's on-axis guard, so an absolute tolerance would change which
 * branch a centred circle takes.
 */
const isApprox = (a: THREE.Vector3, b: THREE.Vector3): boolean =>
  a.distanceToSquared(b) <= 1e-24 * Math.min(a.lengthSq(), b.lengthSq())

/** A plane as Eigen carries one: unit normal plus offset. */
class Plane {
  readonly normal: THREE.Vector3
  readonly offset: number
  constructor(normal: THREE.Vector3, through: THREE.Vector3) {
    this.normal = normal.clone()
    this.offset = -normal.dot(through)
  }
  signedDistance(point: THREE.Vector3): number { return this.normal.dot(point) + this.offset }
  absDistance(point: THREE.Vector3): number { return Math.abs(this.signedDistance(point)) }
  projection(point: THREE.Vector3): THREE.Vector3 {
    return point.clone().addScaledVector(this.normal, -this.signedDistance(point))
  }
}

/** A line as Eigen carries one: a point and a UNIT direction. */
class Line {
  readonly origin: THREE.Vector3
  readonly direction: THREE.Vector3
  constructor(origin: THREE.Vector3, unitDirection: THREE.Vector3) {
    this.origin = origin.clone()
    this.direction = unitDirection.clone()
  }
  static through(a: THREE.Vector3, b: THREE.Vector3): Line { return new Line(a, direction(a, b)) }
  projection(point: THREE.Vector3): THREE.Vector3 {
    return this.origin.clone().addScaledVector(this.direction, point.clone().sub(this.origin).dot(this.direction))
  }
  distance(point: THREE.Vector3): number { return point.distanceTo(this.projection(point)) }
  intersectionPoint(plane: Plane): THREE.Vector3 {
    const t = -(plane.normal.dot(this.origin) + plane.offset) / plane.normal.dot(this.direction)
    return this.origin.clone().addScaledVector(this.direction, t)
  }
}

/**
 * Studio's `orthonormal_basis` (`Measure.cpp:66`): `[U, V, N]` with `N` the normalised input.
 *
 * The axis it builds `U` from is chosen by the LARGEST component of the normal, which is what keeps
 * it well conditioned; picking a fixed axis degenerates whenever the normal happens to align with it.
 */
function orthonormalBasis(v: THREE.Vector3): [THREE.Vector3, THREE.Vector3, THREE.Vector3] {
  const n = v.clone().normalize()
  const abs = new THREE.Vector3(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))
  const index = abs.x >= abs.y && abs.x >= abs.z ? 0 : abs.y >= abs.z ? 1 : 2
  const u = index === 0
    ? new THREE.Vector3(n.y, -n.x, 0).normalize()
    : index === 1
      ? new THREE.Vector3(0, n.z, -n.y).normalize()
      : new THREE.Vector3(-n.z, 0, n.x).normalize()
  return [u, new THREE.Vector3().crossVectors(n, u).normalize(), n]
}

/**
 * Studio's `get_orthogonal` (`MeasureUtils.hpp:359`). NOT interchangeable with
 * {@link orthonormalBasis}'s `U` -- the two pick different vectors, and Studio uses each in places
 * where the other would give a different (still valid, but different) answer.
 */
function getOrthogonal(v: THREE.Vector3, unitLength: boolean): THREE.Vector3 {
  const components = [v.x, v.y, v.z]
  let largest = 0
  for (let i = 1; i < 3; i++) if (Math.abs(components[i]!) > Math.abs(components[largest]!)) largest = i
  const next = (largest + 1) % 3
  const out = [0, 0, 0]
  out[largest] = components[next]!
  out[next] = -components[largest]!
  const result = new THREE.Vector3(out[0], out[1], out[2])
  return unitLength ? result.normalize() : result
}

/** Intersection of two 2D lines given as (normal, constant), for the arc centre. */
function intersect2d(n1: THREE.Vector2, c1: number, n2: THREE.Vector2, c2: number): THREE.Vector2 | null {
  const det = n1.x * n2.y - n1.y * n2.x
  if (Math.abs(det) < 1e-12) return null
  return new THREE.Vector2((c1 * n2.y - c2 * n1.y) / det, (c2 * n1.x - c1 * n2.x) / det)
}

// ---- angles --------------------------------------------------------------------------------------

/**
 * The angle between two edges, and the arc that shows it (`Measure.cpp:683`).
 *
 * The edges are REORIENTED so each points away from where they meet, which is what makes this the
 * interior angle a user expects rather than an arbitrary line-line angle -- the same two lines
 * subtend both an angle and its supplement, and which one is meant depends entirely on which way
 * each edge runs from the corner.
 */
export function angleEdgeEdge(
  e1: readonly [THREE.Vector3, THREE.Vector3],
  e2: readonly [THREE.Vector3, THREE.Vector3]
): AngleAndEdges {
  let e1Unit = direction(e1[0], e1[1])
  let e2Unit = direction(e2[0], e2[1])
  if (areParallel(e1Unit, e2Unit)) return DUMMY_ANGLE

  // Both edges are projected onto the plane they span, so the intersection can be solved in 2D.
  const normal = new THREE.Vector3().crossVectors(e1Unit, e2Unit).normalize()
  const plane = new Plane(normal, e1[0])
  let e11 = plane.projection(e1[0])
  let e12 = plane.projection(e1[1])
  let e21 = plane.projection(e2[0])
  let e22 = plane.projection(e2[1])
  const coplanar = e2[0].distanceTo(e21) < EPSILON && e2[1].distanceTo(e22) < EPSILON

  const toXY = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 0, 1))
  const fromXY = toXY.clone().invert()
  const rot = (point: THREE.Vector3) => point.clone().applyQuaternion(toXY)
  const r11 = rot(e11), r12 = rot(e12), r21 = rot(e21), r22 = rot(e22)
  const flat = (point: THREE.Vector3) => new THREE.Vector2(point.x, point.y)
  // A 2D line through two points, as (normal, constant): the normal is the segment turned 90 deg.
  const lineThrough = (a: THREE.Vector2, b: THREE.Vector2) => {
    const n = new THREE.Vector2(-(b.y - a.y), b.x - a.x).normalize()
    return { n, c: n.dot(a) }
  }
  const l1 = lineThrough(flat(r11), flat(r12))
  const l2 = lineThrough(flat(r21), flat(r22))
  const centre2d = intersect2d(l1.n, l1.c, l2.n, l2.c)
  if (!centre2d) return DUMMY_ANGLE
  const center = new THREE.Vector3(centre2d.x, centre2d.y, r11.z).applyQuaternion(fromXY)

  const out1: [THREE.Vector3, THREE.Vector3] = [e1[0].clone(), e1[1].clone()]
  const out2: [THREE.Vector3, THREE.Vector3] = [e2[0].clone(), e2[1].clone()]
  if (centre2d.distanceToSquared(flat(r11)) > centre2d.distanceToSquared(flat(r12))) {
    ;[e11, e12] = [e12, e11]
    ;[out1[0], out1[1]] = [out1[1], out1[0]]
    e1Unit = e1Unit.clone().negate()
  }
  if (centre2d.distanceToSquared(flat(r21)) > centre2d.distanceToSquared(flat(r22))) {
    ;[e21, e22] = [e22, e21]
    ;[out2[0], out2[1]] = [out2[1], out2[0]]
    e2Unit = e2Unit.clone().negate()
  }

  const angle = Math.acos(THREE.MathUtils.clamp(e1Unit.dot(e2Unit), -1, 1))
  const mid1 = e11.clone().add(e12).multiplyScalar(0.5)
  const mid2 = e21.clone().add(e22).multiplyScalar(0.5)
  const radius = Math.min(center.distanceTo(mid1), center.distanceTo(mid2))
  return { angle, center, e1: out1, e2: out2, radius, coplanar }
}

/**
 * The angle between an edge and a plane (`Measure.cpp:747`).
 *
 * Measured against the edge's own SHADOW on the plane rather than against the plane's normal, which
 * is what makes a chamfer read as (say) 30 degrees rather than 60. The perpendicular case is handled
 * separately because that shadow degenerates to a point there.
 */
export function angleEdgePlane(
  edge: readonly [THREE.Vector3, THREE.Vector3],
  planeNormal: THREE.Vector3,
  planeOrigin: THREE.Vector3
): AngleAndEdges {
  let unit = direction(edge[0], edge[1])
  // Parallel to the plane: there is no angle to report, and no intersection to draw an arc about.
  if (arePerpendicular(unit, planeNormal)) return DUMMY_ANGLE

  const plane = new Plane(planeNormal, planeOrigin)
  const intersection = Line.through(edge[0], edge[1]).intersectionPoint(plane)
  let e1 = edge[0].clone()
  let e2 = edge[1].clone()
  if (e1.distanceToSquared(intersection) > e2.distanceToSquared(intersection)) {
    ;[e1, e2] = [e2, e1]
    unit = unit.clone().negate()
  }

  if (areParallel(unit, planeNormal)) {
    // Square to the plane. Studio hard-codes the right angle here and synthesises the second edge,
    // because the projection the general path needs collapses to nothing.
    const basis = orthonormalBasis(unit)
    const radius = e1.clone().add(e2).multiplyScalar(0.5).distanceTo(intersection)
    const towardsOrigin = basis[1].dot(planeOrigin.clone().sub(intersection)) >= 0 ? basis[1] : basis[1].clone().negate()
    const onPlane: [THREE.Vector3, THREE.Vector3] = [
      intersection.clone(),
      intersection.clone().addScaledVector(towardsOrigin, radius)
    ]
    if (!isApprox(intersection, e1)) {
      onPlane[0].addScaledVector(towardsOrigin, radius)
      onPlane[1].addScaledVector(towardsOrigin, radius)
    }
    return {
      angle: Math.PI / 2,
      center: intersection,
      e1: [e1, e2],
      e2: onPlane,
      radius,
      coplanar: isApprox(intersection, e1)
    }
  }

  const span = e2.clone().sub(e1)
  const length = span.length()
  const temp = new THREE.Vector3().crossVectors(planeNormal, span)
  const onPlaneUnit = new THREE.Vector3().crossVectors(planeNormal, temp).normalize()
  let onPlane: [THREE.Vector3, THREE.Vector3] = [
    planeOrigin.clone(),
    planeOrigin.clone().addScaledVector(onPlaneUnit, length)
  ]
  const test = new THREE.Vector3().crossVectors(onPlane[1].clone().sub(onPlane[0]), span)
  if (test.dot(temp) < 0) {
    onPlane = [planeOrigin.clone(), planeOrigin.clone().addScaledVector(onPlaneUnit, -length)]
  }
  const result = angleEdgeEdge([e1, e2], onPlane)
  // Studio overwrites the radius the edge-edge helper computed (`:794`), because the arc belongs to
  // the edge and its intersection with the plane, not to the synthetic in-plane edge.
  return { ...result, radius: intersection.distanceTo(e1.clone().add(e2).multiplyScalar(0.5)) }
}

/** The angle between two planes (`Measure.cpp:798`), via an edge on each running away from their seam. */
export function anglePlanePlane(
  normal1: THREE.Vector3,
  origin1: THREE.Vector3,
  normal2: THREE.Vector3,
  origin2: THREE.Vector3
): AngleAndEdges {
  if (areParallel(normal1, normal2)) return DUMMY_ANGLE
  const lineDirection = new THREE.Vector3().crossVectors(normal1, normal2).normalize()
  // Any point on the seam does: both plane origins are projected onto it next, and the projection is
  // the same wherever along the line the point sits. Studio solves a 2x3 system for one.
  const seedDenominator = lineDirection.lengthSq()
  const seed = new THREE.Vector3()
    .addScaledVector(new THREE.Vector3().crossVectors(lineDirection, normal2), normal1.dot(origin1))
    .addScaledVector(new THREE.Vector3().crossVectors(normal1, lineDirection), normal2.dot(origin2))
    .divideScalar(seedDenominator)
  const seam = new Line(seed, lineDirection)
  const projected1 = seam.projection(origin1)
  const projected2 = seam.projection(origin2)
  // DIVERGENCE: Studio normalises these unguarded (`Measure.cpp:826`), so a plane whose origin lies
  // ON the seam -- which happens whenever two faces meet symmetrically about their own centres --
  // yields a NaN direction and then a NaN angle, shown to the user as "NaN". There is no arc to draw
  // there, so it is reported as no angle rather than as a wrong one.
  const offset1 = origin1.clone().sub(projected1)
  const offset2 = origin2.clone().sub(projected2)
  if (offset1.lengthSq() < 1e-20 || offset2.lengthSq() < 1e-20) return DUMMY_ANGLE
  const unit1 = offset1.normalize()
  const unit2 = offset2.normalize()
  const radius = Math.max(10, origin1.distanceTo(projected1), origin2.distanceTo(projected2))
  const result = angleEdgeEdge(
    [projected1.clone().addScaledVector(unit1, radius), projected1.clone().addScaledVector(unit1, 2 * radius)],
    [projected2.clone().addScaledVector(unit2, radius), projected2.clone().addScaledVector(unit2, 2 * radius)]
  )
  return { ...result, radius }
}

// ---- the pair table --------------------------------------------------------------------------------

/**
 * Measure between two features, Studio's `get_measurement`.
 *
 * WHICH FIELDS COME BACK is per pair, and deliberately uneven:
 *
 * | pair          | infinite | strict | angle | xyz |
 * |---------------|----------|--------|-------|-----|
 * | point-point   |          | yes    |       | yes |
 * | point-edge    | yes      | yes    |       |     |
 * | point-circle  |          | yes    |       |     |
 * | point-plane   | yes      |        |       |     |
 * | edge-edge     | yes      |        | yes   |     |
 * | edge-circle   | yes      |        |       |     |
 * | edge-plane    | maybe    |        | yes   |     |
 * | circle-circle |          | yes    |       |     |
 * | circle-plane  | maybe    | maybe  |       |     |
 * | plane-plane   | either   |        | either|     |
 *
 * Point-Edge is the only pair reporting both distances, and the panel leans on that to label them
 * "Perpendicular" and "Direct" rather than just "Distance".
 *
 * A circle answers from its RIM. Studio's own tool passes `deal_circle_result = true` at the top
 * level, which re-anchors every circle answer onto the centre and is why hole-to-hole there reads
 * centre-to-centre; we do not, because the centre is separately selectable here (clicking inside the
 * ring picks it as a point) and a control that changes no number is not worth offering. Both
 * questions therefore stay askable, which under Studio's flag they are not.
 */
export function getMeasurement(a: MeasureFeature, b: MeasureFeature): MeasurementResult {
  const swap = FEATURE_ORDER[a.kind] > FEATURE_ORDER[b.kind]
  const f1 = swap ? b : a
  const f2 = swap ? a : b
  const result: MeasurementResult = {}

  if (f1.kind === 'point') {
    if (f2.kind === 'point') {
      const diff = f2.point.clone().sub(f1.point)
      result.distanceStrict = { dist: diff.length(), from: f1.point.clone(), to: f2.point.clone() }
      result.distanceXyz = diff
    } else if (f2.kind === 'edge') {
      const line = new Line(f2.start, direction(f2.start, f2.end))
      const distInfinite = line.distance(f1.point)
      const projection = line.projection(f1.point)
      const lengthSq = f2.start.distanceToSquared(f2.end)
      const fromStartSq = projection.distanceToSquared(f2.start)
      const fromEndSq = projection.distanceToSquared(f2.end)
      if (fromStartSq < lengthSq && fromEndSq < lengthSq) {
        result.distanceStrict = { dist: distInfinite, from: f1.point.clone(), to: projection.clone() }
      } else {
        // Past an end: the nearest point of the SEGMENT is that endpoint, and the distance follows
        // from Pythagoras because the along-edge and perpendicular parts are at right angles.
        const startIsCloser = fromStartSq < fromEndSq
        result.distanceStrict = {
          dist: Math.sqrt(Math.min(fromStartSq, fromEndSq) + distInfinite * distInfinite),
          from: f1.point.clone(),
          to: (startIsCloser ? f2.start : f2.end).clone()
        }
      }
      result.distanceInfinite = { dist: distInfinite, from: f1.point.clone(), to: projection }
    } else if (f2.kind === 'circle') {
      const circlePlane = new Plane(f2.normal, f2.center)
      const projection = circlePlane.projection(f1.point)
      if (isApprox(projection, f2.center)) {
        // On the axis, so every rim point is equally near and the answer is the radius. Note `from`
        // is the CENTRE here, not the queried point -- Studio's only such case.
        result.distanceStrict = {
          dist: f2.radius,
          from: f2.center.clone(),
          to: f2.center.clone().addScaledVector(getOrthogonal(f2.normal, true), f2.radius)
        }
      } else {
        const inPlane = projection.distanceTo(f2.center)
        result.distanceStrict = {
          dist: Math.sqrt((inPlane - f2.radius) ** 2 + f1.point.distanceToSquared(projection)),
          from: f1.point.clone(),
          to: f2.center.clone().addScaledVector(projection.clone().sub(f2.center).normalize(), f2.radius)
        }
      }
    } else {
      const plane = new Plane(f2.normal, f2.origin)
      result.distanceInfinite = {
        dist: plane.absDistance(f1.point),
        from: f1.point.clone(),
        to: plane.projection(f1.point)
      }
    }
  } else if (f1.kind === 'edge') {
    if (f2.kind === 'edge') {
      const candidates: DistAndPoints[] = []
      const addPointEdge = (v: THREE.Vector3, edge: readonly [THREE.Vector3, THREE.Vector3]) => {
        const strict = getMeasurement({ kind: 'point', point: v }, { kind: 'edge', start: edge[0], end: edge[1] }).distanceStrict
        if (!strict) return
        const along = edge[1].clone().sub(edge[0])
        const toFoot = strict.to.clone().sub(edge[0])
        if (toFoot.dot(along) >= 0 && toFoot.length() < along.length()) {
          candidates.push({ dist: strict.dist, from: v.clone(), to: strict.to.clone() })
        }
      }
      const e1: [THREE.Vector3, THREE.Vector3] = [f1.start, f1.end]
      const e2: [THREE.Vector3, THREE.Vector3] = [f2.start, f2.end]
      // The four endpoint pairs come FIRST, and the order matters: ties take the earliest candidate.
      candidates.push({ dist: e2[0].distanceTo(e1[0]), from: e1[0].clone(), to: e2[0].clone() })
      candidates.push({ dist: e2[1].distanceTo(e1[0]), from: e1[0].clone(), to: e2[1].clone() })
      candidates.push({ dist: e2[0].distanceTo(e1[1]), from: e1[1].clone(), to: e2[0].clone() })
      candidates.push({ dist: e2[1].distanceTo(e1[1]), from: e1[1].clone(), to: e2[1].clone() })
      addPointEdge(e1[0], e2)
      addPointEdge(e1[1], e2)
      // These two put `from` on the SECOND edge, inverting the convention the rest of the function
      // keeps. Studio does not correct it, and the overlay draws the anchors as given, so neither
      // do we -- "fixing" it would move the drawn line off Studio's.
      addPointEdge(e2[0], e1)
      addPointEdge(e2[1], e1)
      result.distanceInfinite = candidates.reduce((best, item) => (item.dist < best.dist ? item : best))
      result.angle = angleEdgeEdge(e1, e2)
    } else if (f2.kind === 'circle') {
      const along = f1.end.clone().sub(f1.start)
      const alongUnit = along.clone().normalize()
      const candidates: DistAndPoints[] = []
      for (const end of [f1.start, f1.end]) {
        // Scored on RIM distance, deliberately: the flag is not propagated in Studio either.
        const strict = getMeasurement({ kind: 'point', point: end }, f2).distanceStrict
        if (strict) candidates.push(strict)
      }
      const crossing = Line.through(f1.start, f1.end).intersectionPoint(new Plane(alongUnit, f2.center))
      const toCrossing = crossing.clone().sub(f1.start)
      if (toCrossing.dot(along) >= 0 && toCrossing.length() < along.length()) {
        const strict = getMeasurement({ kind: 'point', point: crossing }, f2).distanceStrict
        if (strict) candidates.push(strict)
      }
      // Studio scores the candidates on RIM distance and then reports the winner's distance to the
      // CENTRE, which is how one of its answers can name a nearer point than the number beside it.
      // Reporting what was scored is the whole of our divergence here.
      result.distanceInfinite = candidates.reduce((winner, item) => (item.dist < winner.dist ? item : winner))
    } else if (f2.kind === 'plane') {
      const unit = direction(f1.start, f1.end)
      if (arePerpendicular(unit, f2.normal)) {
        // Running parallel to the plane, so the nearer endpoint answers it.
        const plane = new Plane(f2.normal, f2.origin)
        const candidates = [f1.start, f1.end].map((end) => ({
          dist: plane.absDistance(end),
          from: end.clone(),
          to: plane.projection(end)
        }))
        result.distanceInfinite = candidates.reduce((best, item) => (item.dist < best.dist ? item : best))
      } else {
        // Oblique: measured against the plane's own boundary edges rather than its infinite extent,
        // so the answer describes the face the user can see.
        const candidates: DistAndPoints[] = []
        for (const edge of f2.edges) {
          const measured = getMeasurement({ kind: 'edge', start: edge[0], end: edge[1] }, f1).distanceInfinite
          if (!measured) { candidates.length = 0; break }
          candidates.push(measured)
        }
        if (candidates.length > 0) {
          result.distanceInfinite = candidates.reduce((best, item) => (item.dist < best.dist ? item : best))
        }
      }
      result.angle = angleEdgePlane([f1.start, f1.end], f2.normal, f2.origin)
    }
  } else if (f1.kind === 'circle') {
    if (f2.kind === 'circle') {
      result.distanceStrict = closestRimPoints(f1, f2)
    } else if (f2.kind === 'plane') {
      const coplanar = areParallel(f1.normal, f2.normal)
        && new Plane(f1.normal, f1.center).absDistance(f2.origin) < EPSILON
      if (coplanar) {
        // Studio reports zero with the plane's origin as the far anchor, so `dist` is deliberately
        // not the distance between the two points it hands back.
        result.distanceStrict = { dist: 0, from: f1.center.clone(), to: f2.origin.clone() }
      } else {
        const candidates: DistAndPoints[] = []
        for (const edge of f2.edges) {
          const measured = getMeasurement({ kind: 'edge', start: edge[0], end: edge[1] }, f1).distanceInfinite
          if (!measured) { candidates.length = 0; break }
          candidates.push(measured)
        }
        result.distanceInfinite = candidates.length > 0
          ? candidates.reduce((best, item) => (item.dist < best.dist ? item : best))
          : {
            dist: new Plane(f2.normal, f2.origin).absDistance(f1.center),
            from: f1.center.clone(),
            to: new Plane(f2.normal, f2.origin).projection(f1.center)
          }
      }
    }
  } else if (f1.kind === 'plane' && f2.kind === 'plane') {
    if (areParallel(f1.normal, f2.normal)) {
      const plane = new Plane(f2.normal, f2.origin)
      result.distanceInfinite = {
        dist: plane.absDistance(f1.origin),
        from: f1.origin.clone(),
        to: plane.projection(f1.origin)
      }
    } else {
      result.angle = anglePlanePlane(f1.normal, f1.origin, f2.normal, f2.origin)
    }
  }

  if (swap) {
    // Only the ANCHORS are put back into the caller's order. `dist` is symmetric, and the angle's
    // edges stay canonical -- Studio does not swap them either, and the arc looks the same.
    for (const entry of [result.distanceInfinite, result.distanceStrict]) {
      if (!entry) continue
      const from = entry.from
      entry.from = entry.to
      entry.to = from
    }
  }
  return result
}

/**
 * The nearest points on two circles' RIMS, measured over the rims we actually detected.
 *
 * Studio solves this with a degree-8 polynomial (`DistCircle3Circle3`) because it works from the
 * ideal circle. Ours already holds each rim as the loop of real model vertices the detection walked,
 * so the shortest span between those is both simpler and a truer answer about the part: it measures
 * the geometry that will be printed rather than the circle fitted through it. The cost is bounded by
 * the tessellation -- a 64-segment rim is within a thousandth of a millimetre of the ideal arc at
 * any radius a printed hole has.
 *
 * Falls back to the centre distance if either rim is missing, which happens only for a circle built
 * by hand rather than extracted from a mesh.
 *
 * COST: the pairwise search is O(n x m), and a rim is the raw border loop the detection walked, not a
 * fixed 64-segment idealisation, so a dense CAD face can bring thousands of vertices to a search that
 * runs synchronously on the second click. Each rim is therefore SUBSAMPLED to a bounded stride first.
 * The answer is unchanged in practice because a rim is convex and smooth: the true nearest pair lies
 * on the arcs facing each other, which any even sampling still lands on to within a fraction of the
 * segment length, itself already below the tessellation error the whole measurement carries.
 */
function closestRimPoints(a: MeshCircle, b: MeshCircle): DistAndPoints {
  if (a.rim.length === 0 || b.rim.length === 0) {
    return { dist: a.center.distanceTo(b.center), from: a.center.clone(), to: b.center.clone() }
  }
  let best: DistAndPoints | null = null
  for (const from of sampleRim(a.rim)) {
    for (const to of sampleRim(b.rim)) {
      const dist = from.distanceTo(to)
      if (!best || dist < best.dist) best = { dist, from: from.clone(), to: to.clone() }
    }
  }
  return best!
}

/** At most `RIM_SAMPLE_LIMIT` evenly spaced vertices of a rim, and the rim itself when it is short. */
function sampleRim(rim: readonly THREE.Vector3[]): readonly THREE.Vector3[] {
  if (rim.length <= RIM_SAMPLE_LIMIT) return rim
  const stride = rim.length / RIM_SAMPLE_LIMIT
  const sampled: THREE.Vector3[] = []
  for (let i = 0; i < RIM_SAMPLE_LIMIT; i += 1) sampled.push(rim[Math.floor(i * stride)]!)
  return sampled
}

/**
 * Vertices per rim the rim-to-rim search may consider.
 *
 * 256 caps the pairwise work at ~65k distance tests, imperceptible on a click, while being far more
 * than the tessellation of any hole a printer resolves: a 256-segment circle is within a millionth of
 * its radius of the ideal arc.
 */
const RIM_SAMPLE_LIMIT = 256

/**
 * Whether a pair offers a per-axis breakdown: Studio's `can_set_xyz_distance` (`Measure.cpp:1302`).
 *
 * Point-Point only, and the reason is not arbitrary: it is the one pair whose anchors are UNAMBIGUOUS
 * points, so a signed per-axis delta describes something stable. Every other pair anchors on contact
 * or projection points that slide as either feature moves.
 *
 * DIVERGENCE: Studio also qualifies Circle-Circle, because there a circle IS its centre. Ours
 * measures rim to rim, so the anchors are two tessellation vertices, and a breakdown over them would
 * report the gap's components rather than the centre offset, jittering off zero for two holes on a
 * common axis as the mesh happened to place their vertices. Selecting the two CENTRES is point to
 * point and gives the breakdown properly, which is the measurement that question was really asking.
 */
export function canSetXyzDistance(a: MeasureFeature, b: MeasureFeature): boolean {
  return a.kind === 'point' && b.kind === 'point'
}

/**
 * The per-axis delta to SHOW, which is not simply `distanceXyz`.
 *
 * A qualifying pair can leave the field unpopulated, so Studio's panel falls back to the anchors of
 * whichever distance it got (`GLGizmoMeasure.cpp:2594`). Kept because the fallback is what the panel
 * and any other reader must agree on, not because a surviving pair still needs it.
 */
export function measurementXyzDelta(result: MeasurementResult): THREE.Vector3 {
  if (result.distanceXyz && result.distanceXyz.length() > EPSILON) return result.distanceXyz.clone()
  const fallback = result.distanceInfinite ?? result.distanceStrict
  return fallback ? fallback.to.clone().sub(fallback.from) : new THREE.Vector3()
}

/** One line of the readout: a label, the bare value, and the unit shown after it. */
export interface MeasurementRow {
  label: string
  /** Formatted WITHOUT its unit, since this is what a copy button puts on the clipboard. */
  value: string
  unit: string
}

/**
 * Exactly what the readout says about a measurement.
 *
 * One definition rather than the panel deciding inline, because which rows appear for which pair is
 * a rule rather than a layout: a perpendicular and a direct distance that happen to be equal collapse
 * into a single row, an angle is judged by its value rather than its presence, and the per-axis
 * breakdown belongs only to the pairs that anchor on unambiguous points.
 */
export function measurementRows(
  first: MeasureFeature,
  second: MeasureFeature,
  result: MeasurementResult
): MeasurementRow[] {
  const rows: MeasurementRow[] = []
  // An angle is always PRESENT for some pairs and zero when it means nothing -- Studio's `Dummy` goes
  // into the optional rather than replacing it -- so the value decides, not the field.
  if (result.angle && result.angle.angle > 1e-6) {
    rows.push({ label: 'Angle', value: ((result.angle.angle * 180) / Math.PI).toFixed(2), unit: '°' })
  }
  const strict = result.distanceStrict
  const infinite = result.distanceInfinite
  // Both are named only when they genuinely differ; otherwise one value under two headings reads as
  // two separate measurements.
  const showBoth = Boolean(strict && infinite && Math.abs(strict.dist - infinite.dist) > 1e-4)
  if (infinite) {
    rows.push({ label: showBoth ? 'Perpendicular' : 'Distance', value: infinite.dist.toFixed(2), unit: ' mm' })
  }
  if (strict && (showBoth || !infinite)) {
    rows.push({ label: showBoth ? 'Direct' : 'Distance', value: strict.dist.toFixed(2), unit: ' mm' })
  }
  // The per-axis breakdown appears only where the PAIR offers one and the delta says something.
  const delta = canSetXyzDistance(first, second) ? measurementXyzDelta(result) : null
  if (delta && delta.length() > 1e-4) {
    // SIGNED, as Studio reports them: the sign says which side of the first feature the second is on.
    rows.push({ label: 'ΔX', value: delta.x.toFixed(2), unit: ' mm' })
    rows.push({ label: 'ΔY', value: delta.y.toFixed(2), unit: ' mm' })
    rows.push({ label: 'ΔZ', value: delta.z.toFixed(2), unit: ' mm' })
  }
  return rows
}

