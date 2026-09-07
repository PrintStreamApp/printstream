/**
 * Hole-centre detection for the measure tool.
 *
 * What is worth pinning here is not that a round hole reads as round -- almost any fit does that --
 * but the REFUSALS, since a detector that accepts everything snaps the measure point to the centre
 * of shapes that have no centre. Every accepting test therefore has a control beside it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import {
  buildMeshCircleIndex,
  circleFromBorderLoop,
  circlesAroundFace,
  featureAtFace,
  featuresForPlane,
  fitCircleToLoop,
  measureFeatureLabel,
  sameMeasureFeature,
  transformMeasureFeature,
  type MeasureFeature
} from './measureFeatures.js'

const UP = new THREE.Vector3(0, 0, 1)

/** Points evenly spaced around a circle, which is what a bore's rim is. */
function circlePoints(radius: number, segments: number, center = new THREE.Vector3(), z = 0): THREE.Vector3[] {
  return Array.from({ length: segments }, (_, i) => {
    const angle = (i / segments) * Math.PI * 2
    return new THREE.Vector3(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius, z)
  })
}

/**
 * A flat annulus: the simplest surface with BOTH an outer border and a hole, and one whose answers
 * are analytic. Wound so its normal is +Z.
 */
function annulusSoup(innerRadius: number, outerRadius: number, segments: number, z = 0): Float32Array {
  const out: number[] = []
  const at = (radius: number, i: number) => {
    const angle = ((i % segments) / segments) * Math.PI * 2
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, z]
  }
  for (let i = 0; i < segments; i++) {
    const innerHere = at(innerRadius, i)
    const innerNext = at(innerRadius, i + 1)
    const outerHere = at(outerRadius, i)
    const outerNext = at(outerRadius, i + 1)
    out.push(...innerHere, ...outerHere, ...outerNext)
    out.push(...innerHere, ...outerNext, ...innerNext)
  }
  return new Float32Array(out)
}

/** A plain square face: one plane, one 4-point border, and nothing round anywhere. */
function squareSoup(size: number): Float32Array {
  const h = size / 2
  return new Float32Array([
    -h, -h, 0, h, -h, 0, h, h, 0,
    -h, -h, 0, h, h, 0, -h, h, 0
  ])
}

test('a bore is found as the inner border of the face it passes through, with its true centre', () => {
  // The whole mechanism in one assertion. Studio finds a hole this way rather than by fitting a
  // cylinder to its wall, which is what makes it work for a pocket and a through-hole alike.
  const index = buildMeshCircleIndex(annulusSoup(3, 10, 48))
  const circles = circlesAroundFace(index, 0)
  const radii = circles.map((circle) => circle.radius).sort((a, b) => a - b)
  assert.equal(circles.length, 2, `expected the hole and the outer rim, got ${radii.join(', ')}`)
  for (const circle of circles) {
    assert.ok(circle.center.length() < 1e-4, `centre off the axis at ${circle.center.toArray().join(', ')}`)
  }
  // A polygon through N segments inscribes the circle, so the fitted radius is the mean vertex
  // distance -- exactly the radius, since every vertex is on it.
  assert.ok(Math.abs(radii[0]! - 3) < 1e-4, `inner radius ${radii[0]}`)
  assert.ok(Math.abs(radii[1]! - 10) < 1e-4, `outer radius ${radii[1]}`)
})

test('a face with no hole offers no circle at all', () => {
  // The control. Without it the test above passes for a detector that answers "circle" to anything:
  // a square's border is 4 points, which Studio refuses to even fit, because a circle through four
  // points always fits perfectly.
  const index = buildMeshCircleIndex(squareSoup(20))
  assert.deepEqual(circlesAroundFace(index, 0), [])
})

test('the hole is found on a face that is neither axis-aligned nor at the origin', () => {
  // The fit works in a frame built from the plane normal, and a frame built wrong still returns a
  // plausible centre -- just not on the model. Tilting and translating is what catches that.
  const flat = annulusSoup(2.5, 8, 40)
  const rotation = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.6, -0.4, 1.1))
  const offset = new THREE.Vector3(120, -35, 14)
  const moved = new Float32Array(flat.length)
  const point = new THREE.Vector3()
  for (let i = 0; i < flat.length; i += 3) {
    point.set(flat[i]!, flat[i + 1]!, flat[i + 2]!).applyMatrix4(rotation).add(offset)
    moved[i] = point.x; moved[i + 1] = point.y; moved[i + 2] = point.z
  }
  const index = buildMeshCircleIndex(moved)
  const circles = circlesAroundFace(index, 0)
  assert.equal(circles.length, 2)
  for (const circle of circles) {
    assert.ok(
      circle.center.distanceTo(offset) < 1e-3,
      `centre landed at ${circle.center.toArray().join(', ')}, not on the model at ${offset.toArray().join(', ')}`
    )
  }
})

test('a rounded rectangle is refused, however well a circle happens to fit it', () => {
  // The reason the edge-length test exists. Its corner arcs sit near one circle, so a residual check
  // alone lets it through -- and snapping to "the centre" of a rounded rectangle is a measurement of
  // nothing.
  const points: THREE.Vector3[] = []
  const corners: Array<[number, number]> = [[6, 3], [-6, 3], [-6, -3], [6, -3]]
  for (const [cx, cy] of corners) {
    for (let i = 0; i < 6; i++) {
      const angle = Math.atan2(cy, cx) + (i / 6) * 0.4
      points.push(new THREE.Vector3(cx + Math.cos(angle) * 0.5, cy + Math.sin(angle) * 0.5, 0))
    }
  }
  assert.equal(circleFromBorderLoop(points, UP), null)
})

test('a loop of four points or fewer is never a circle', () => {
  // Studio refuses to fit below five points, and the reason is not a threshold on quality: a circle
  // through any four points fits them exactly, so the residual can never reject one.
  assert.equal(circleFromBorderLoop(circlePoints(5, 4), UP), null)
  assert.equal(circleFromBorderLoop(circlePoints(5, 3), UP), null)
  assert.ok(circleFromBorderLoop(circlePoints(5, 5), UP))
})

test('a hex socket is a centre too, not six unrelated edges', () => {
  // Studio reports 5 to 8 equal-length points as edges CARRYING the centre, which is the same answer
  // one seam down. A hex hole is a thing users measure between.
  const hex = circleFromBorderLoop(circlePoints(4, 6), UP)
  assert.ok(hex, 'a regular hexagon should yield a centre')
  assert.ok(hex.center.length() < 1e-6)
})

test('the fit reports the WORST radial deviation, not the average', () => {
  // The threshold is calibrated against Studio's L-infinity residual. An RMS residual over the same
  // points is always smaller, so using one silently accepts loops Studio rejects -- and the shapes
  // that differ are exactly those with a few bad points among many good ones.
  const points = circlePoints(10, 40)
  points[0]!.setX(points[0]!.x + 0.4)
  const fit = fitCircleToLoop(points, UP)
  assert.ok(fit)
  const deviations = points.map((point) => Math.abs(Math.hypot(point.x - fit.center.x, point.y - fit.center.y) - fit.radius))
  const worst = Math.max(...deviations)
  const rms = Math.sqrt(deviations.reduce((sum, value) => sum + value * value, 0) / deviations.length)
  assert.ok(rms < worst / 2, 'fixture is void unless the two norms genuinely differ here')
  assert.ok(Math.abs(fit.error - worst) < 1e-6, `reported ${fit.error}, worst deviation is ${worst}`)
})

test('collinear points report no circle rather than an arbitrary one', () => {
  const line = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(i, 0, 0))
  assert.equal(fitCircleToLoop(line, UP), null)
})

test('two holes in ONE face come back as two separate rims, neither borrowing the other\'s points', () => {
  // The realistic shape: a CAD top face, connected, with holes of DIFFERENT segment counts. A
  // border walk that hops between loops at a shared vertex would return one rim containing points
  // from both holes -- which draws as an outline with a long excursion across the model, and is
  // indistinguishable from a rendering fault unless the geometry is checked directly.
  const outline = new THREE.Shape([
    new THREE.Vector2(-20, -10), new THREE.Vector2(20, -10),
    new THREE.Vector2(20, 10), new THREE.Vector2(-20, 10)
  ])
  const hole = (cx: number, radius: number, segments: number) => {
    const path = new THREE.Path()
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const x = cx + Math.cos(angle) * radius
      const y = Math.sin(angle) * radius
      if (i === 0) path.moveTo(x, y)
      else path.lineTo(x, y)
    }
    path.closePath()
    return path
  }
  outline.holes = [hole(-10, 3, 48), hole(10, 5, 24)]
  const geometry = new THREE.ShapeGeometry(outline).toNonIndexed()
  const index = buildMeshCircleIndex(geometry.getAttribute('position').array as Float32Array)

  assert.equal(index.facesOfPlane.length, 1, 'the face is connected and flat, so it is one plane')
  const circles = circlesAroundFace(index, 0).sort((a, b) => a.radius - b.radius)
  // The rectangular outer border is not round, so only the two holes are circles.
  assert.equal(circles.length, 2, `expected two holes, got ${circles.map((c) => c.radius).join(', ')}`)
  assert.ok(Math.abs(circles[0]!.radius - 3) < 1e-3)
  assert.ok(Math.abs(circles[1]!.radius - 5) < 1e-3)
  assert.ok(circles[0]!.center.distanceTo(new THREE.Vector3(-10, 0, 0)) < 1e-3)
  assert.ok(circles[1]!.center.distanceTo(new THREE.Vector3(10, 0, 0)) < 1e-3)
  // The point of the test: EVERY vertex of each rim is on its own circle. One stray point from the
  // other hole is what a merged loop looks like, and the centre would still come out about right.
  for (const circle of circles) {
    for (const vertex of circle.rim) {
      assert.ok(
        Math.abs(vertex.distanceTo(circle.center) - circle.radius) < 1e-3,
        `a rim vertex sits ${vertex.distanceTo(circle.center).toFixed(2)}mm from its centre, radius ${circle.radius.toFixed(2)}`
      )
    }
  }
})

test('a flat face yields its boundary edges and the plane, and no interior edge', () => {
  // The square is two triangles, so it has an interior diagonal. An extraction that walked every
  // triangle edge would offer that diagonal as a feature -- a line the user cannot see, sitting
  // across the middle of the face.
  const h = 10
  const features = featuresForPlane(buildMeshCircleIndex(new Float32Array([
    -h, -h, 0, h, -h, 0, h, h, 0,
    -h, -h, 0, h, h, 0, -h, h, 0
  ])), 0)
  const edges = features.filter((feature) => feature.kind === 'edge')
  assert.equal(edges.length, 4, 'a square has four boundary edges')
  for (const edge of edges) {
    assert.ok(
      edge.kind === 'edge' && Math.abs(edge.start.distanceTo(edge.end) - 2 * h) < 1e-6,
      'every edge should be a full side; a diagonal would be longer'
    )
  }
  // The plane is LAST, which the hover search depends on: it walks all but the final entry so a
  // nearby edge always beats the face it belongs to.
  const plane = features[features.length - 1]
  assert.equal(plane?.kind, 'plane')
  assert.ok(plane.kind === 'plane' && plane.normal.equals(new THREE.Vector3(0, 0, 1)))
  assert.ok(plane.kind === 'plane' && plane.origin.length() < 1e-6, 'the cog of a centred square is the origin')
})

test('a tessellated straight edge is ONE edge, not the segments it was drawn with', () => {
  // Studio merges collinear edges (`Measure.cpp:481`). Without it a side split by a neighbouring
  // feature offers several edges where the user sees one line, and each measures differently
  // depending on which segment the cursor happened to be near.
  const face = new Float32Array([
    // A square whose bottom side is split into two collinear segments by an extra vertex.
    -10, -10, 0, 0, -10, 0, 10, 10, 0,
    0, -10, 0, 10, -10, 0, 10, 10, 0,
    -10, -10, 0, 10, 10, 0, -10, 10, 0
  ])
  const edges = featuresForPlane(buildMeshCircleIndex(face), 0).filter((feature) => feature.kind === 'edge')
  const bottom = edges.filter((edge) => edge.kind === 'edge' && edge.start.y === -10 && edge.end.y === -10)
  assert.equal(bottom.length, 1, `the split side should merge into one edge, got ${bottom.length}`)
})

/** A plate face with one hole, which between them offer all four feature kinds to hover. */
function plateWithHole(): Float32Array {
  const outline = new THREE.Shape([
    new THREE.Vector2(-20, -10), new THREE.Vector2(20, -10),
    new THREE.Vector2(20, 10), new THREE.Vector2(-20, 10)
  ])
  const path = new THREE.Path()
  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * Math.PI * 2
    const x = Math.cos(angle) * 4
    const y = Math.sin(angle) * 4
    if (i === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  }
  path.closePath()
  outline.holes = [path]
  return new THREE.ShapeGeometry(outline).toNonIndexed().getAttribute('position').array as Float32Array
}

test('the hover resolves to whatever is nearest: the hole, an edge, a corner, or the face', () => {
  // The whole pick in one test, because what matters is the ORDERING between them -- each of these
  // points is inside the same face, and a rule that answered "plane" for all of them would look
  // perfectly reasonable until you tried to measure anything.
  const index = buildMeshCircleIndex(plateWithHole())
  const faceAt = (x: number, y: number) => {
    // Any face of the plate will do: they are all one plane.
    void x; void y
    return 0
  }
  const at = (x: number, y: number, limit = 0.5) =>
    featureAtFace(index, faceAt(x, y), new THREE.Vector3(x, y, 0), limit)

  // Just off the hole's rim.
  assert.equal(at(4.2, 0)?.kind, 'circle')
  // Just inside the plate's own edge, away from any corner.
  assert.equal(at(0, 9.8)?.kind, 'edge')
  // Near a corner of the plate: the ENDPOINT wins over the edge it ends.
  assert.equal(at(19.9, 9.9)?.kind, 'point')
  // Out in open face, near nothing.
  assert.equal(at(10, 0)?.kind, 'plane')
})

test('the face is the fallback, never a winner', () => {
  // Studio's loop skips the last feature, which is the plane, and point-to-plane reports no strict
  // distance anyway. Both guards matter: a face measured against a cursor sitting ON it is zero
  // away, so without them the plane would win every hover and no feature would be reachable.
  const index = buildMeshCircleIndex(plateWithHole())
  const onRim = featureAtFace(index, 0, new THREE.Vector3(4.05, 0, 0), 0.5)
  assert.equal(onRim?.kind, 'circle', 'a cursor on the face still resolves to the rim it is near')
})

test('the hover reach is a parameter, so a zoomed-out view can widen it', () => {
  // Studio's own limit is a fixed 0.5mm in model space, which is sub-pixel when zoomed out and makes
  // nothing reachable. Taking it as an argument is what lets the caller spend a pixel budget instead.
  const index = buildMeshCircleIndex(plateWithHole())
  const wellOut = new THREE.Vector3(6, 0, 0)
  assert.equal(featureAtFace(index, 0, wellOut, 0.5)?.kind, 'plane', 'out of reach at Studio\'s limit')
  assert.equal(featureAtFace(index, 0, wellOut, 3)?.kind, 'circle', 'in reach when the limit is widened')
})

test('a feature carried into world space keeps its normal and radius honest under scaling', () => {
  // Normals and radii cannot simply be multiplied by the matrix. A normal transformed directly is
  // wrong the moment the object is scaled unevenly -- which the editor allows per axis -- and a
  // radius has no single value at all once a circle is squashed. Studio carries both as transformed
  // POINTS and re-derives, so the answer is what that geometry actually became.
  const circle: MeasureFeature = {
    kind: 'circle',
    center: new THREE.Vector3(0, 0, 0),
    normal: new THREE.Vector3(0, 0, 1),
    radius: 2,
    rim: [new THREE.Vector3(2, 0, 0)]
  }
  const scaled = transformMeasureFeature(
    circle,
    new THREE.Matrix4().makeScale(3, 3, 1).setPosition(5, 6, 7)
  )
  assert.equal(scaled.kind, 'circle')
  assert.ok(scaled.kind === 'circle' && Math.abs(scaled.radius - 6) < 1e-6, 'the radius follows the scale')
  assert.ok(scaled.kind === 'circle' && scaled.center.distanceTo(new THREE.Vector3(5, 6, 7)) < 1e-6)
  // Scaling in the plane leaves a +Z normal pointing at +Z; transforming it directly would too here,
  // which is why the interesting case is the one below.
  assert.ok(scaled.kind === 'circle' && scaled.normal.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-6)

  // Squashing ALONG the normal is where a directly-transformed normal goes wrong: the matrix scales
  // z by 1/4, so a naively transformed (0,0,1) would come back as (0,0,0.25) before normalising --
  // fine here, but the tilted case below is not.
  const tilted: MeasureFeature = {
    kind: 'plane',
    planeId: 0,
    normal: new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2),
    origin: new THREE.Vector3(),
    borders: [],
    edges: []
  }
  const squashed = transformMeasureFeature(tilted, new THREE.Matrix4().makeScale(1, 1, 0.25))
  assert.ok(squashed.kind === 'plane')
  assert.ok(Math.abs(squashed.normal.length() - 1) < 1e-9, 'still a unit normal')
  // The surface tilts CLOSER to horizontal when z is squashed, so the normal tilts toward +Z.
  assert.ok(squashed.normal.z > Math.SQRT1_2, 'the normal followed the surface, not the matrix')
})

test('a point is named after what it came from, and a circle centre says so', () => {
  // The label is the only thing distinguishing a free point on a face from a vertex, or a circle's
  // centre from a point on its rim -- and those measure differently against a plane or an edge, so
  // reading "Vertex" for all of them would hide which measurement is being taken.
  const centre = new THREE.Vector3(1, 2, 3)
  const source: MeasureFeature = {
    kind: 'circle', center: centre, normal: new THREE.Vector3(0, 0, 1), radius: 5, rim: []
  }
  assert.equal(measureFeatureLabel(source), 'Circle')
  assert.equal(measureFeatureLabel({ kind: 'point', point: centre.clone() }, source), 'Center of circle')
  assert.equal(measureFeatureLabel({ kind: 'point', point: new THREE.Vector3(6, 2, 3) }, source), 'Point on circle')

  const plane: MeasureFeature = {
    kind: 'plane', planeId: 0, normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(), borders: [], edges: []
  }
  assert.equal(measureFeatureLabel({ kind: 'point', point: new THREE.Vector3(4, 4, 0) }, plane), 'Point on plane')

  const edge: MeasureFeature = { kind: 'edge', start: new THREE.Vector3(), end: new THREE.Vector3(10, 0, 0) }
  assert.equal(measureFeatureLabel({ kind: 'point', point: new THREE.Vector3(5, 0, 0) }, edge), 'Point on edge')
  // A feature picked WHOLE is named for itself, not for a source it happens to equal.
  assert.equal(measureFeatureLabel(edge, edge), 'Edge')
})

test('two features are the same whichever way round an edge is given', () => {
  // The selection lifecycle turns on this: clicking a feature that is ALREADY selected deselects it,
  // and the same edge reached from two faces of one plane can arrive with its ends swapped. Compared
  // naively, clicking the same edge twice would add it a second time instead of removing it.
  const a: MeasureFeature = { kind: 'edge', start: new THREE.Vector3(), end: new THREE.Vector3(10, 0, 0) }
  const reversed: MeasureFeature = { kind: 'edge', start: new THREE.Vector3(10, 0, 0), end: new THREE.Vector3() }
  assert.ok(sameMeasureFeature(a, reversed))
  assert.ok(!sameMeasureFeature(a, { kind: 'edge', start: new THREE.Vector3(), end: new THREE.Vector3(9, 0, 0) }))
  // Different KINDS at the same place are different features: a vertex and the circle centred on it
  // measure differently against a plane.
  assert.ok(!sameMeasureFeature(
    { kind: 'point', point: new THREE.Vector3(1, 2, 3) },
    { kind: 'circle', center: new THREE.Vector3(1, 2, 3), normal: new THREE.Vector3(0, 0, 1), radius: 2, rim: [] }
  ))
  assert.ok(!sameMeasureFeature(a, null))
})
