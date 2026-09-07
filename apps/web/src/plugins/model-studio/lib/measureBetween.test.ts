/**
 * Distances and angles between measured features.
 *
 * Every case here has an answer that can be worked out by hand, because the whole point of the port
 * is agreeing with BambuStudio to the millimetre -- a plausible-looking number is exactly the
 * failure mode that cannot be spotted in the viewport.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  canSetXyzDistance,
  getMeasurement,
  measurementXyzDelta,
  type MeasurementResult
} from './measureBetween.js'
import type { MeasureFeature } from './measureFeatures.js'

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const point = (x: number, y: number, z: number): MeasureFeature => ({ kind: 'point', point: v(x, y, z) })
const edge = (a: THREE.Vector3, b: THREE.Vector3): MeasureFeature => ({ kind: 'edge', start: a, end: b })
const circle = (center: THREE.Vector3, normal: THREE.Vector3, radius: number): MeasureFeature =>
  ({ kind: 'circle', center, normal, radius, rim: [] })

/** A square plane feature, with the boundary edges a plane measurement is taken against. */
function squarePlane(normal: THREE.Vector3, origin: THREE.Vector3, half = 10): MeasureFeature {
  const basis = new THREE.Vector3(1, 0, 0)
  const u = Math.abs(normal.dot(basis)) > 0.9
    ? new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0)).normalize()
    : new THREE.Vector3().crossVectors(normal, basis).normalize()
  const w = new THREE.Vector3().crossVectors(normal, u).normalize()
  const corners = [
    origin.clone().addScaledVector(u, -half).addScaledVector(w, -half),
    origin.clone().addScaledVector(u, half).addScaledVector(w, -half),
    origin.clone().addScaledVector(u, half).addScaledVector(w, half),
    origin.clone().addScaledVector(u, -half).addScaledVector(w, half)
  ]
  return {
    kind: 'plane',
    planeId: 0,
    normal,
    origin,
    borders: [corners],
    edges: corners.map((corner, i) => [corner, corners[(i + 1) % corners.length]!] as [THREE.Vector3, THREE.Vector3])
  }
}

const near = (actual: number, expected: number, what: string, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${what}: ${actual}, expected ${expected}`)

const degrees = (result: MeasurementResult) => THREE.MathUtils.radToDeg(result.angle?.angle ?? NaN)

test('point to point reports the distance, and the only per-axis breakdown there is', () => {
  const result = getMeasurement(point(0, 0, 0), point(3, 4, 12))
  near(result.distanceStrict!.dist, 13, 'distance')
  assert.deepEqual(result.distanceXyz?.toArray(), [3, 4, 12])
  // Studio populates `distance_xyz` for this pair alone; every other anchor pair is a contact point
  // that slides, so a signed axis delta would not describe anything stable.
  assert.equal(result.distanceInfinite, undefined)
})

test('point to edge reports BOTH the perpendicular and the direct distance', () => {
  // The only pair that fills both, which is what lets the panel label them separately rather than
  // showing one ambiguous "Distance".
  const beyond = getMeasurement(point(20, 3, 0), edge(v(0, 0, 0), v(10, 0, 0)))
  near(beyond.distanceInfinite!.dist, 3, 'perpendicular to the infinite line')
  // Past the end, so the nearest point of the SEGMENT is the endpoint: hypot(10, 3).
  near(beyond.distanceStrict!.dist, Math.hypot(10, 3), 'direct to the segment')
  assert.deepEqual(beyond.distanceStrict!.to.toArray(), [10, 0, 0])

  // Over the segment the two agree, which is how the panel decides to show one row instead of two.
  const over = getMeasurement(point(5, 3, 0), edge(v(0, 0, 0), v(10, 0, 0)))
  near(over.distanceInfinite!.dist, 3, 'perpendicular')
  near(over.distanceStrict!.dist, 3, 'direct')
})

test('point to circle measures to the RIM, the centre being its own selection', () => {
  // A circle picked as a circle measures from its ring; picking its centre yields a POINT, and the
  // two answers must differ or offering both is pointless.
  const c = circle(v(0, 0, 0), v(0, 0, 1), 5)
  near(getMeasurement(point(20, 0, 0), c).distanceStrict!.dist, 15, 'to the rim')
  near(getMeasurement(point(20, 0, 0), point(0, 0, 0)).distanceStrict!.dist, 20, 'to the centre')
})

test('a point on a circle\'s axis reports the radius rather than dividing by zero', () => {
  // Every rim point is equally near, so there is no nearest one to name. Studio answers with the
  // radius and anchors from the CENTRE -- its only case where `from` is not the queried point.
  const result = getMeasurement(point(0, 0, 7), circle(v(0, 0, 0), v(0, 0, 1), 5))
  near(result.distanceStrict!.dist, 5, 'radius')
  assert.deepEqual(result.distanceStrict!.from.toArray(), [0, 0, 0])
})

test('circle to circle falls back to the centres when no rim was detected', () => {
  // A circle fitted from an arc rather than a closed loop carries no rim vertices, and a rim-to-rim
  // answer over nothing is worse than the centre one: it would be silently absent.
  const a = circle(v(0, 0, 0), v(0, 0, 1), 5)
  const b = circle(v(30, 0, 40), v(0, 0, 1), 2)
  near(getMeasurement(a, b).distanceStrict!.dist, 50, 'centre distance')
  // The per-axis breakdown of that question is reached by picking the two CENTRES, which is
  // point-to-point and anchors on something that does not move with the tessellation.
  const centres = getMeasurement(point(0, 0, 0), point(30, 0, 40))
  assert.ok(canSetXyzDistance(point(0, 0, 0), point(30, 0, 40)))
  assert.deepEqual(measurementXyzDelta(centres).toArray(), [30, 0, 40])
})

test('two perpendicular edges meeting at a corner measure 90 degrees', () => {
  const result = getMeasurement(edge(v(0, 0, 0), v(10, 0, 0)), edge(v(0, 0, 0), v(0, 10, 0)))
  near(degrees(result), 90, 'angle')
  near(result.distanceInfinite!.dist, 0, 'they touch')
})

test('the angle is the one between the edges as DRAWN, not its supplement', () => {
  // Two lines subtend both an angle and 180 minus it; which is meant depends on which way each edge
  // runs from the corner. Studio reorients both to point away from where they meet, so this is 45
  // rather than 135 -- reversing an edge must not change the answer.
  const corner = v(0, 0, 0)
  const along = edge(corner, v(10, 0, 0))
  const diagonal = edge(corner, v(10, 10, 0))
  near(degrees(getMeasurement(along, diagonal)), 45, 'angle')
  near(degrees(getMeasurement(along, edge(v(10, 10, 0), corner))), 45, 'angle with the edge reversed')
})

test('parallel edges report a present-but-zero angle rather than no angle', () => {
  // Studio's `Dummy` goes INTO the optional, so a surface testing "is there an angle" shows a
  // confident 0 degrees for two parallel edges. Anything user-facing has to test the value.
  const result = getMeasurement(edge(v(0, 0, 0), v(10, 0, 0)), edge(v(0, 5, 0), v(10, 5, 0)))
  assert.ok(result.angle, 'the angle is present')
  near(result.angle!.angle, 0, 'and it is zero')
  near(result.distanceInfinite!.dist, 5, 'the distance is still real')
})

test('an edge out of a plane measures 180 minus its elevation, which is Studio\'s answer', () => {
  // Worth pinning because it is NOT the number intuition offers, and I asserted 45 here first.
  // Studio builds the second edge along `n x (n x e)`, which equals `n(n.e) - e` and so points
  // AGAINST the edge's shadow on the plane; its sign correction does not fire for an edge rising
  // out of a face. So a 45-degree edge reads 135. Derived by hand from `Measure.cpp:782-790` before
  // trusting the port -- a plausible wrong angle is exactly what cannot be caught in the viewport.
  const plane = squarePlane(v(0, 0, 1), v(0, 0, 0))
  near(degrees(getMeasurement(edge(v(0, 0, 0), v(10, 0, 10)), plane)), 135, 'a 45-degree edge', 1e-4)
  // Continuous into the perpendicular case, which Studio hard-codes separately: 180 - 90 is 90.
  near(degrees(getMeasurement(edge(v(0, 0, 0), v(0, 0, 10)), plane)), 90, 'a square edge', 1e-4)
})

test('an edge parallel to a plane has a distance and no meaningful angle', () => {
  const plane = squarePlane(v(0, 0, 1), v(0, 0, 0))
  const result = getMeasurement(edge(v(0, 0, 4), v(10, 0, 4)), plane)
  near(result.distanceInfinite!.dist, 4, 'height above the plane')
  near(result.angle!.angle, 0, 'no angle to report')
})

test('parallel planes measure their separation; angled ones measure their angle', () => {
  const lower = squarePlane(v(0, 0, 1), v(0, 0, 0))
  const upper = squarePlane(v(0, 0, 1), v(0, 0, 6))
  near(getMeasurement(lower, upper).distanceInfinite!.dist, 6, 'wall thickness')
  assert.equal(getMeasurement(lower, upper).angle, undefined, 'parallel planes report no angle')

  // Both origins sit OFF the seam the planes share. On it, the direction each plane's edge runs
  // away from that seam is undefined -- Studio produces NaN there; see the guard in `anglePlanePlane`.
  const flat = squarePlane(v(0, 0, 1), v(0, 5, 0))
  const tilted = squarePlane(v(0, -Math.SQRT1_2, Math.SQRT1_2), v(0, 1, 1))
  const angled = getMeasurement(flat, tilted)
  near(degrees(angled), 45, 'angle between the faces', 1e-4)
  assert.equal(angled.distanceInfinite, undefined, 'and no distance')
})

test('the anchors come back in the caller\'s argument order, whichever way round it asked', () => {
  // Everything is measured in a canonical Point < Edge < Circle < Plane order, so without the
  // un-swap the overlay would draw its line from the wrong feature for half of all pairs.
  const p = point(0, 0, 10)
  const plane = squarePlane(v(0, 0, 1), v(0, 0, 0))
  const forward = getMeasurement(p, plane).distanceInfinite!
  const backward = getMeasurement(plane, p).distanceInfinite!
  assert.deepEqual(forward.from.toArray(), [0, 0, 10])
  assert.deepEqual(forward.to.toArray(), [0, 0, 0])
  assert.deepEqual(backward.from.toArray(), [0, 0, 0])
  assert.deepEqual(backward.to.toArray(), [0, 0, 10])
  near(forward.dist, backward.dist, 'the distance itself is symmetric')
})

test('only point-point offers a per-axis breakdown', () => {
  const p = point(0, 0, 0)
  const e = edge(v(0, 0, 0), v(1, 0, 0))
  const c = circle(v(0, 0, 0), v(0, 0, 1), 1)
  const plane = squarePlane(v(0, 0, 1), v(0, 0, 0))
  assert.ok(canSetXyzDistance(p, p))
  // Circle-circle qualifies in Studio, where a circle IS its centre. Ours anchors on two rim
  // vertices, so a signed axis delta would report the gap's components and jitter with the mesh.
  assert.ok(!canSetXyzDistance(c, c))
  assert.ok(!canSetXyzDistance(p, e))
  assert.ok(!canSetXyzDistance(p, c))
  assert.ok(!canSetXyzDistance(e, plane))
  assert.ok(!canSetXyzDistance(plane, plane))
})

test('a circle answers from its rim and its centre from the centre, against an edge', () => {
  // Two different questions, and before the rim was reachable they returned the same number. The
  // circle's own answer still comes from Studio's candidate walk, which includes the foot of the
  // perpendicular from the centre -- but scored, and now reported, against the RIM.
  const segment = edge(v(0, 0, 0), v(10, 0, 0))
  const overhead = circle(v(5, 8, 0), v(0, 0, 1), 2)
  near(getMeasurement(segment, overhead).distanceInfinite!.dist, 6, 'rim to edge')
  near(getMeasurement(segment, point(5, 8, 0)).distanceInfinite!.dist, 8, 'centre to edge')
})

test('a circle and its centre differ against a plane too', () => {
  // Circle-to-plane measures against the face's BOUNDARY EDGES, so it answers a different question
  // from a perpendicular dropped out of the centre.
  const face = squarePlane(v(0, 0, 1), v(0, 0, 0))
  const above = circle(v(0, 0, 12), v(0, 0, 1), 3)
  near(getMeasurement(point(0, 0, 12), face).distanceInfinite!.dist, 12, 'perpendicular from the centre')
  assert.ok(
    getMeasurement(above, face).distanceInfinite!.dist > 12,
    'the circle answers against the boundary, which is further'
  )
})

test('two circles measure rim to rim, so the gap between holes is the answer', () => {
  // Pointing at a ring measures the ring. Two 10mm-radius holes 30mm apart leave a 10mm gap, which
  // is the number a wall thickness question wants; their centre spacing is one click away by
  // selecting each centre instead.
  const rim = (cx: number, radius: number) => Array.from({ length: 64 }, (_, i) => {
    const angle = (i / 64) * Math.PI * 2
    return v(cx + Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
  })
  const left: MeasureFeature = {
    kind: 'circle', center: v(0, 0, 0), normal: v(0, 0, 1), radius: 10, rim: rim(0, 10)
  }
  const right: MeasureFeature = {
    kind: 'circle', center: v(30, 0, 0), normal: v(0, 0, 1), radius: 10, rim: rim(30, 10)
  }
  // Measured over the rims we detected, so it is the tessellated gap rather than the ideal one --
  // within a thousandth of a millimetre at 64 segments, and it describes the geometry that prints.
  near(getMeasurement(left, right).distanceStrict!.dist, 10, 'the gap between the holes', 0.02)
  near(getMeasurement(point(0, 0, 0), point(30, 0, 0)).distanceStrict!.dist, 30, 'centre to centre')
})

test('edge to circle falls back to the ENDPOINTS when the perpendicular foot misses the segment', () => {
  // The only cover for the endpoint candidates. With the foot on the segment they never decide the
  // answer, so a regression that broke them would pass every other test in this file silently.
  const segment = edge(v(0, 0, 0), v(10, 0, 0))
  const offToTheSide = circle(v(20, 5, 0), v(0, 0, 1), 2)
  const result = getMeasurement(segment, offToTheSide)
  // The near endpoint wins, and its answer is exactly what that endpoint measures on its own.
  const fromNearEnd = getMeasurement(point(10, 0, 0), offToTheSide).distanceStrict!.dist
  near(result.distanceInfinite!.dist, fromNearEnd, 'the nearer endpoint decides')
  near(result.distanceInfinite!.dist, Math.hypot(10, 5) - 2, 'measured to the rim')
})

test('a circle and its centre differ against an edge', () => {
  // The case that started this: a hole 6mm from an edge, 3.2mm across. Its RIM is 4.4mm from the
  // edge and its CENTRE is 6mm, and before this both selections answered 6.
  const segment = edge(v(-50, 0, 0), v(50, 0, 0))
  const rim = Array.from({ length: 64 }, (_, i) => {
    const angle = (i / 64) * Math.PI * 2
    return v(Math.cos(angle) * 1.6, 6 + Math.sin(angle) * 1.6, 0)
  })
  const hole: MeasureFeature = { kind: 'circle', center: v(0, 6, 0), normal: v(0, 0, 1), radius: 1.6, rim }
  near(getMeasurement(segment, hole).distanceInfinite!.dist, 4.4, 'rim to edge', 0.01)
  near(getMeasurement(segment, point(0, 6, 0)).distanceInfinite!.dist, 6, 'centre to edge')
})
