import assert from 'node:assert/strict'
import test from 'node:test'
import * as THREE from 'three'
import {
  applyBucketFill,
  applyHeightRangePaint,
  applySingleTrianglePaint,
  applySmartFill,
  applySupportPaintBrush,
  buildTriangleScanData,
  decodeWholeTriangleColorState,
  encodeWholeTriangleColorState,
  getTriangleAdjacency,
  SUPPORT_PAINT_BLOCKER_CODE,
  SUPPORT_PAINT_ENFORCER_CODE
} from './supportPaint'

// Two unit triangles in the z=0 plane (normals +Z), one near the origin and one 100mm
// away, as a non-indexed position stream (9 floats per triangle).
const POSITIONS = new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  100, 0, 0, 101, 0, 0, 100, 1, 0
])

test('buildTriangleScanData computes centroids and unit face normals', () => {
  const scan = buildTriangleScanData(POSITIONS)
  assert.equal(scan.count, 2)
  // float32 storage: tolerance scales with magnitude (epsilon ~7.6e-6 near 100).
  assert.ok(Math.abs(scan.centroids[0]! - 1 / 3) < 1e-6)
  assert.ok(Math.abs(scan.centroids[3]! - (100 + 1 / 3)) < 1e-4)
  assert.deepEqual([scan.normals[0], scan.normals[1], scan.normals[2]], [0, 0, 1])
})

test('applySupportPaintBrush paints facing triangles within the radius only', () => {
  const scan = buildTriangleScanData(POSITIONS)
  const codes: Record<number, string> = {}
  // Brush at the first triangle, looking down (-Z): triangle normals (+Z) face the viewer.
  const changed = applySupportPaintBrush({
    codes,
    scan,
    point: { x: 0.33, y: 0.33, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5,
    mode: 'enforcer'
  })
  assert.equal(changed, true)
  assert.deepEqual(codes, { 0: SUPPORT_PAINT_ENFORCER_CODE })

  // Looking up (+Z) the triangles face away from the viewer: nothing paints.
  const rearCodes: Record<number, string> = {}
  const rearChanged = applySupportPaintBrush({
    codes: rearCodes,
    scan,
    point: { x: 0.33, y: 0.33, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    radius: 5,
    mode: 'blocker'
  })
  assert.equal(rearChanged, false)
  assert.deepEqual(rearCodes, {})
})

test('applySupportPaintBrush paints large triangles it touches, splitting to the brush', () => {
  // One large triangle: the centroid is ~23mm from the brushed corner, far beyond the
  // brush radius — the brush sphere touches the surface, so it must paint, and the
  // partial coverage must produce a split tree rather than painting the whole polygon.
  const scan = buildTriangleScanData(new Float32Array([0, 0, 0, 50, 0, 0, 0, 50, 0]))
  const codes: Record<number, string> = {}
  const changed = applySupportPaintBrush({
    codes,
    scan,
    point: { x: 1, y: 1, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 3,
    mode: 'enforcer'
  })
  assert.equal(changed, true)
  assert.ok(codes[0])
  assert.ok(codes[0]!.length > 1, 'expected a split-tree code, not a whole-triangle nibble')
})

test('applySupportPaintBrush overwrites other paint and the eraser removes it', () => {
  const scan = buildTriangleScanData(POSITIONS)
  const codes: Record<number, string> = { 0: SUPPORT_PAINT_ENFORCER_CODE, 1: SUPPORT_PAINT_BLOCKER_CODE }
  const brush = {
    scan,
    point: { x: 0.33, y: 0.33, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5
  }
  assert.equal(applySupportPaintBrush({ ...brush, codes, mode: 'blocker' }), true)
  assert.equal(codes[0], SUPPORT_PAINT_BLOCKER_CODE)
  // The far triangle is outside the radius and keeps its paint.
  assert.equal(codes[1], SUPPORT_PAINT_BLOCKER_CODE)

  assert.equal(applySupportPaintBrush({ ...brush, codes, mode: 'eraser' }), true)
  assert.equal(codes[0], undefined)
  assert.equal(codes[1], SUPPORT_PAINT_BLOCKER_CODE)
  // Erasing already-clean triangles reports no change.
  assert.equal(applySupportPaintBrush({ ...brush, codes, mode: 'eraser' }), false)
})

test('colour-paint codes round-trip the Bambu nibble encoding', () => {
  // Filaments 1-2 are single nibbles; 3+ use the 'C' extension with a leading nibble.
  assert.equal(encodeWholeTriangleColorState(1), '4')
  assert.equal(encodeWholeTriangleColorState(2), '8')
  assert.equal(encodeWholeTriangleColorState(3), '0C')
  assert.equal(encodeWholeTriangleColorState(4), '1C')
  assert.equal(encodeWholeTriangleColorState(0), null)
  assert.equal(encodeWholeTriangleColorState(16), null)
  for (const filamentId of [1, 2, 3, 4, 15]) {
    assert.equal(decodeWholeTriangleColorState(encodeWholeTriangleColorState(filamentId)!), filamentId)
  }
  // Split codes are not whole-triangle states.
  assert.equal(decodeWholeTriangleColorState('1C84'), null)
  assert.equal(decodeWholeTriangleColorState('C'), null)
})

test('applySupportPaintBrush paints an explicit colour state when provided', () => {
  const scan = buildTriangleScanData(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  const codes: Record<number, string> = {}
  applySupportPaintBrush({
    codes,
    scan,
    point: { x: 0.3, y: 0.3, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5,
    mode: 'enforcer',
    state: 3
  })
  // The brush covers the whole triangle, so it stays one leaf: filament 3 = '0C'.
  assert.deepEqual(codes, { 0: '0C' })
})

// A 1x1 square split into two triangles (shared diagonal (1,0,0)-(0,1,0), normals +Z),
// plus a third triangle folded 90 degrees down from the square's right edge.
const FOLDED_POSITIONS = new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0,
  1, 0, 0, 1, 1, 0, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1, 0, -1
])

test('getTriangleAdjacency links faces across shared edges', () => {
  const scan = buildTriangleScanData(FOLDED_POSITIONS)
  const adjacency = getTriangleAdjacency(scan)
  // Triangle 0 shares its v1-v2 side (the diagonal) with triangle 1's v2-v0 side.
  assert.equal(adjacency[0 * 3 + 1], 1)
  assert.equal(adjacency[1 * 3 + 2], 0)
  // Triangle 1 shares its v0-v1 side (the right edge) with the folded triangle 2.
  assert.equal(adjacency[1 * 3 + 0], 2)
  assert.equal(adjacency[2 * 3 + 0], 1)
  // Outer edges stay open.
  assert.equal(adjacency[0 * 3 + 0], -1)
  assert.equal(adjacency[0 * 3 + 2], -1)
})

test('smart fill floods across smooth edges and stops at sharp ones', () => {
  const scan = buildTriangleScanData(FOLDED_POSITIONS)
  const codes: Record<number, string> = {}
  const changed = applySmartFill({ codes, scan, seedTriangle: 0, angleDeg: 30, state: 1 })
  assert.equal(changed, true)
  // The two coplanar triangles fill; the 90-degree fold does not.
  assert.deepEqual(codes, { 0: '4', 1: '4' })

  // A limit wider than the fold angle lets the fill wrap around it.
  const wide: Record<number, string> = {}
  applySmartFill({ codes: wide, scan, seedTriangle: 0, angleDeg: 95, state: 2 })
  assert.deepEqual(wide, { 0: '8', 1: '8', 2: '8' })

  // Erasing flood-fills state 0 over the same region.
  applySmartFill({ codes, scan, seedTriangle: 1, angleDeg: 30, state: 0 })
  assert.deepEqual(codes, {})
})

test('bucket fill repaints the connected same-state region only', () => {
  const scan = buildTriangleScanData(FOLDED_POSITIONS)
  // The flat square is red (state 2); the folded wall is unpainted.
  const codes: Record<number, string> = { 0: '8', 1: '8' }
  const changed = applyBucketFill({ codes, scan, seedTriangle: 0, state: 1 })
  assert.equal(changed, true)
  assert.deepEqual(codes, { 0: '4', 1: '4' })

  // Filling the unpainted region does not cross into the painted one.
  applyBucketFill({ codes, scan, seedTriangle: 2, state: 3 })
  assert.deepEqual(codes, { 0: '4', 1: '4', 2: '0C' })

  // Erase-fill clears just the clicked region.
  applyBucketFill({ codes, scan, seedTriangle: 0, state: 0 })
  assert.deepEqual(codes, { 2: '0C' })
})

test('edge detection stops brush growth at sharp edges', () => {
  const scan = buildTriangleScanData(FOLDED_POSITIONS)
  // Brush over the square's right edge, viewing diagonally so the flat top AND the
  // folded wall both face the camera; the sphere covers parts of both.
  const stroke = {
    point: { x: 1, y: 0.5, z: 0 },
    direction: { x: -Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 },
    radius: 0.6,
    mode: 'enforcer' as const,
    seedTriangle: 1
  }
  const free: Record<number, string> = {}
  applySupportPaintBrush({ codes: free, scan, ...stroke })
  assert.ok(free[2], 'without edge detection the stroke wraps the 90-degree fold')

  const gated: Record<number, string> = {}
  applySupportPaintBrush({ codes: gated, scan, ...stroke, propagationAngleDeg: 30 })
  assert.ok(gated[1], 'the seeded face still paints')
  assert.equal(gated[2], undefined, 'edge detection keeps the stroke off the fold')
})

test('triangleAllowed gates painting and growth (on-overhangs-only)', () => {
  const scan = buildTriangleScanData(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
  const codes: Record<number, string> = {}
  const changed = applySupportPaintBrush({
    codes,
    scan,
    point: { x: 0.3, y: 0.3, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5,
    mode: 'enforcer',
    triangleAllowed: () => false
  })
  assert.equal(changed, false)
  assert.deepEqual(codes, {})
})

test('single-triangle paint sets exactly one whole facet', () => {
  const codes: Record<number, string> = {}
  assert.equal(applySingleTrianglePaint({ codes, seedTriangle: 1, state: 3 }), true)
  assert.deepEqual(codes, { 1: '0C' })
  assert.equal(applySingleTrianglePaint({ codes, seedTriangle: 1, state: 3 }), false)
  assert.equal(applySingleTrianglePaint({ codes, seedTriangle: 1, state: 0 }), true)
  assert.deepEqual(codes, {})
})

test('height-range paint bands every triangle crossing the z slab', () => {
  // Two vertical 10x10 wall triangles (in the xz plane) plus one entirely above the band.
  const scan = buildTriangleScanData(new Float32Array([
    0, 0, 0, 10, 0, 0, 0, 0, 10,
    10, 0, 0, 10, 0, 10, 0, 0, 10,
    0, 0, 20, 10, 0, 20, 0, 0, 30
  ]))
  const codes: Record<number, string> = {}
  const changed = applyHeightRangePaint({
    codes,
    scan,
    zBottom: 2,
    zTop: 3,
    state: 2,
    localToWorld: new THREE.Matrix4(),
    averageScale: 1
  })
  assert.equal(changed, true)
  // Both wall triangles cross the band and get split trees; the high triangle is untouched.
  assert.ok(codes[0] && codes[0].length > 1)
  assert.ok(codes[1] && codes[1].length > 1)
  assert.equal(codes[2], undefined)
})

test('the circle brush with a seed stays on connected geometry only', () => {
  // Two identical front-facing (+Z) triangles, the second 5mm behind the first along
  // the view ray: the infinite circle cylinder covers both, connectivity only the first.
  const scan = buildTriangleScanData(new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, -5, 1, 0, -5, 0, 1, -5
  ]))
  const seeded: Record<number, string> = {}
  applySupportPaintBrush({
    codes: seeded,
    scan,
    point: { x: 0.3, y: 0.3, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5,
    mode: 'enforcer',
    shape: 'circle',
    seedTriangle: 0
  })
  assert.deepEqual(seeded, { 0: SUPPORT_PAINT_ENFORCER_CODE })

  // Without a seed the full scan paints everything the cylinder touches.
  const unseeded: Record<number, string> = {}
  applySupportPaintBrush({
    codes: unseeded,
    scan,
    point: { x: 0.3, y: 0.3, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 5,
    mode: 'enforcer',
    shape: 'circle'
  })
  assert.deepEqual(unseeded, { 0: SUPPORT_PAINT_ENFORCER_CODE, 1: SUPPORT_PAINT_ENFORCER_CODE })
})

test('a partially covered triangle splits so paint follows the brush', () => {
  // 100mm right triangle, brush only over the corner at the origin.
  const scan = buildTriangleScanData(new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0]))
  const codes: Record<number, string> = {}
  const changed = applySupportPaintBrush({
    codes,
    scan,
    point: { x: 2, y: 2, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 6,
    mode: 'enforcer'
  })
  assert.equal(changed, true)
  // The code is a split tree (longer than a whole-triangle nibble) and erasing the
  // same spot restores an empty map.
  assert.ok(codes[0]!.length > 1)
  applySupportPaintBrush({
    codes,
    scan,
    point: { x: 2, y: 2, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
    radius: 6,
    mode: 'eraser'
  })
  assert.deepEqual(codes, {})
})
