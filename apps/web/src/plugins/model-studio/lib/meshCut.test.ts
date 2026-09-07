import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { isClosedSoup } from './meshBooleanCore'
import { CONNECTOR_DEFAULTS, CONNECTOR_SHAPE_SIDES, connectorVolumes } from './cutConnectors'
import { GROOVE_CUT_DEFAULTS, axisAlignedCutFor, capSoupForHalf, cutHalfForSide, drillBoresIntoHalf, grooveCutPieces, grooveDefaultsForSize, grooveSizeLimitsForSize, isGrooveShapeValid, cutTriangleSoup, cutTriangleSoupAtZ, cutTriangleSoupByPlane, cutTriangleSoupWithGroove, helperVolumeCutSides, orientCutHalfSoup, planeEpsilonAt, rebaseTriangleSoup, shiftTriangleSoup, splitTriangleSoup, triangleSoupToBinaryStl, triangleSoupXYCenter, triangleSoupsEqual } from './meshCut'

/** Append a quad (two triangles) a->b->c->d with the given winding. */
function quad(out: number[], a: number[], b: number[], c: number[], d: number[]): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** Axis-aligned box soup with outward winding. */
function boxSoup(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const out: number[] = []
  quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]) // front (y0, normal -y)
  quad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]) // back (y1, normal +y)
  quad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]) // left (x0, normal -x)
  quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]) // right (x1, normal +x)
  quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]) // top (z1, normal +z)
  quad(out, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]) // bottom (z0, normal -z)
  return new Float32Array(out)
}

/** Signed volume of a closed, outward-wound triangle soup (divergence theorem). */
function signedVolume(soup: Float32Array): number {
  let volume = 0
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [
      soup[o]!, soup[o + 1]!, soup[o + 2]!, soup[o + 3]!, soup[o + 4]!, soup[o + 5]!, soup[o + 6]!, soup[o + 7]!, soup[o + 8]!
    ]
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
  }
  return volume
}

/** Every undirected edge of a watertight, consistently wound soup appears exactly twice, once per direction. */
function assertWatertight(soup: Float32Array, label: string): void {
  const directed = new Map<string, number>()
  const key = (x: number, y: number, z: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`
  for (let o = 0; o + 8 < soup.length; o += 9) {
    const k = [key(soup[o]!, soup[o + 1]!, soup[o + 2]!), key(soup[o + 3]!, soup[o + 4]!, soup[o + 5]!), key(soup[o + 6]!, soup[o + 7]!, soup[o + 8]!)]
    for (let i = 0; i < 3; i++) {
      const edge = `${k[i]}>${k[(i + 1) % 3]}`
      directed.set(edge, (directed.get(edge) ?? 0) + 1)
    }
  }
  for (const [edge, count] of directed) {
    assert.equal(count, 1, `${label}: directed edge repeated (${edge})`)
    const [a, b] = edge.split('>')
    assert.equal(directed.get(`${b}>${a}`) ?? 0, 1, `${label}: edge ${edge} has no reverse twin (open or flipped surface)`)
  }
}

test('cutTriangleSoupAtZ splits a cube into two watertight boxes with the right volumes', () => {
  const cube = boxSoup(0, 0, 0, 20, 20, 20)
  assert.ok(Math.abs(signedVolume(cube) - 8000) < 1e-6)

  const { upper, lower } = cutTriangleSoupAtZ(cube, 8)
  assert.ok(Math.abs(signedVolume(lower) - 20 * 20 * 8) < 1e-3, `lower volume ${signedVolume(lower)}`)
  assert.ok(Math.abs(signedVolume(upper) - 20 * 20 * 12) < 1e-3, `upper volume ${signedVolume(upper)}`)
  assertWatertight(lower, 'lower')
  assertWatertight(upper, 'upper')
  // Bounding checks: the halves share only the cut plane.
  for (let i = 2; i < lower.length; i += 3) assert.ok(lower[i]! <= 8 + 1e-5)
  for (let i = 2; i < upper.length; i += 3) assert.ok(upper[i]! >= 8 - 1e-5)
})

test('cutTriangleSoupAtZ caps a cross-section with a hole (washer)', () => {
  // Outer 40x40 box minus inner 20x20 box, z 0..10: build as outer walls + inner walls
  // (inward winding) + top/bottom annulus rings.
  const out: number[] = []
  const [o0, o1, i0, i1] = [0, 40, 10, 30]
  quad(out, [o0, o0, 0], [o1, o0, 0], [o1, o0, 10], [o0, o0, 10])
  quad(out, [o1, o1, 0], [o0, o1, 0], [o0, o1, 10], [o1, o1, 10])
  quad(out, [o0, o1, 0], [o0, o0, 0], [o0, o0, 10], [o0, o1, 10])
  quad(out, [o1, o0, 0], [o1, o1, 0], [o1, o1, 10], [o1, o0, 10])
  // Inner walls (normals point into the hole).
  quad(out, [i1, i0, 0], [i0, i0, 0], [i0, i0, 10], [i1, i0, 10])
  quad(out, [i0, i1, 0], [i1, i1, 0], [i1, i1, 10], [i0, i1, 10])
  quad(out, [i0, i0, 0], [i0, i1, 0], [i0, i1, 10], [i0, i0, 10])
  quad(out, [i1, i1, 0], [i1, i0, 0], [i1, i0, 10], [i1, i1, 10])
  // Top annulus (+z) and bottom annulus (-z), four trapezoids each.
  const top = 10, bottom = 0
  quad(out, [o0, o0, top], [o1, o0, top], [i1, i0, top], [i0, i0, top])
  quad(out, [o1, o0, top], [o1, o1, top], [i1, i1, top], [i1, i0, top])
  quad(out, [o1, o1, top], [o0, o1, top], [i0, i1, top], [i1, i1, top])
  quad(out, [o0, o1, top], [o0, o0, top], [i0, i0, top], [i0, i1, top])
  quad(out, [i0, i0, bottom], [i1, i0, bottom], [o1, o0, bottom], [o0, o0, bottom])
  quad(out, [i1, i0, bottom], [i1, i1, bottom], [o1, o1, bottom], [o1, o0, bottom])
  quad(out, [i1, i1, bottom], [i0, i1, bottom], [o0, o1, bottom], [o1, o1, bottom])
  quad(out, [i0, i1, bottom], [i0, i0, bottom], [o0, o0, bottom], [o0, o1, bottom])
  const washer = new Float32Array(out)
  const expectedVolume = (40 * 40 - 20 * 20) * 10
  assert.ok(Math.abs(signedVolume(washer) - expectedVolume) < 1e-6, `washer volume ${signedVolume(washer)}`)

  const { upper, lower } = cutTriangleSoupAtZ(washer, 4)
  assert.ok(Math.abs(signedVolume(lower) - (40 * 40 - 20 * 20) * 4) < 1e-3, `lower volume ${signedVolume(lower)}`)
  assert.ok(Math.abs(signedVolume(upper) - (40 * 40 - 20 * 20) * 6) < 1e-3, `upper volume ${signedVolume(upper)}`)
  assertWatertight(lower, 'washer lower')
  assertWatertight(upper, 'washer upper')
})

test('cutTriangleSoup cuts along X and Y with preserved orientation and watertight halves', () => {
  // Asymmetric box so each axis has a distinct split: x 0..20, y 0..30, z 0..10.
  const box = boxSoup(0, 0, 0, 20, 30, 10)

  const xCut = cutTriangleSoup(box, 'x', 5)
  assert.ok(Math.abs(signedVolume(xCut.lower) - 5 * 30 * 10) < 1e-3, `x lower volume ${signedVolume(xCut.lower)}`)
  assert.ok(Math.abs(signedVolume(xCut.upper) - 15 * 30 * 10) < 1e-3, `x upper volume ${signedVolume(xCut.upper)}`)
  assertWatertight(xCut.lower, 'x lower')
  assertWatertight(xCut.upper, 'x upper')
  for (let i = 0; i < xCut.lower.length; i += 3) assert.ok(xCut.lower[i]! <= 5 + 1e-5)
  for (let i = 0; i < xCut.upper.length; i += 3) assert.ok(xCut.upper[i]! >= 5 - 1e-5)

  const yCut = cutTriangleSoup(box, 'y', 12)
  assert.ok(Math.abs(signedVolume(yCut.lower) - 20 * 12 * 10) < 1e-3, `y lower volume ${signedVolume(yCut.lower)}`)
  assert.ok(Math.abs(signedVolume(yCut.upper) - 20 * 18 * 10) < 1e-3, `y upper volume ${signedVolume(yCut.upper)}`)
  assertWatertight(yCut.lower, 'y lower')
  assertWatertight(yCut.upper, 'y upper')
  for (let i = 1; i < yCut.lower.length; i += 3) assert.ok(yCut.lower[i]! <= 12 + 1e-5)
  for (let i = 1; i < yCut.upper.length; i += 3) assert.ok(yCut.upper[i]! >= 12 - 1e-5)
})

test('cutTriangleSoupAtZ returns an empty half when the plane misses the mesh', () => {
  const cube = boxSoup(0, 0, 0, 10, 10, 10)
  const above = cutTriangleSoupAtZ(cube, 15)
  assert.equal(above.upper.length, 0)
  assert.ok(Math.abs(signedVolume(above.lower) - 1000) < 1e-6)
})

test('rebaseTriangleSoup centres XY and floors Z, returning the removed offset', () => {
  const cube = boxSoup(100, 50, 7, 120, 90, 27)
  const { offset } = rebaseTriangleSoup(cube)
  assert.deepEqual(offset, { x: 110, y: 70, z: 7 })
  let minX = Infinity, maxX = -Infinity, minZ = Infinity
  for (let i = 0; i < cube.length; i += 3) {
    minX = Math.min(minX, cube[i]!); maxX = Math.max(maxX, cube[i]!); minZ = Math.min(minZ, cube[i + 2]!)
  }
  assert.ok(Math.abs(minX + 10) < 1e-5 && Math.abs(maxX - 10) < 1e-5)
  assert.ok(Math.abs(minZ) < 1e-5)
})

test('triangleSoupToBinaryStl writes a well-formed binary STL', () => {
  const cube = boxSoup(0, 0, 0, 10, 10, 10)
  const stl = triangleSoupToBinaryStl(cube)
  assert.equal(stl.byteLength, 84 + 12 * 50)
  const view = new DataView(stl)
  assert.equal(view.getUint32(80, true), 12)
  // First triangle is the front face: normal -y.
  assert.ok(Math.abs(view.getFloat32(84 + 4, true) - -1) < 1e-6)
})

test('splitTriangleSoup separates disconnected shells, largest first', () => {
  const big = boxSoup(0, 0, 0, 20, 20, 20)
  const small = boxSoup(50, 50, 0, 60, 60, 10)
  const combined = new Float32Array(big.length + small.length)
  combined.set(small, 0)
  combined.set(big, small.length)
  const parts = splitTriangleSoup(combined)
  assert.equal(parts.length, 2)
  // Both shells come out intact (exact volumes, watertight), in either order:
  // the largest-first sort is by triangle count and these tie at 12 triangles.
  const volumes = parts.map((part) => Math.round(signedVolume(part))).sort((a, b) => a - b)
  assert.deepEqual(volumes, [1000, 8000])
  assertWatertight(parts[0]!, 'first shell')
  assertWatertight(parts[1]!, 'second shell')
  // A single connected shell comes back whole.
  assert.equal(splitTriangleSoup(big).length, 1)
})

// USER-REPORTED DATA LOSS (2026-07-29): cutting an object lost its modifiers/blockers. A helper
// volume is never geometrically cut: BambuStudio assigns it by bounding box and carries a volume
// that STRADDLES the plane onto BOTH halves (`ModelObject::process_modifier_cut`, Model.cpp). These
// pin that rule; the editor's cut handler carries whatever they select onto each half.
test('a helper volume entirely on one side of the cut goes to that side only', () => {
  const above = boxSoup(0, 0, 12, 4, 4, 16)
  assert.deepEqual(helperVolumeCutSides(above, 'z', 10), { lower: false, upper: true })
  const below = boxSoup(0, 0, 2, 4, 4, 6)
  assert.deepEqual(helperVolumeCutSides(below, 'z', 10), { lower: true, upper: false })
})

test('a helper volume straddling the cut is carried onto BOTH halves', () => {
  // Not cut in half, each piece keeps the whole volume, because the region it describes is
  // meaningful to both. This is the case that silently vanished before.
  const straddling = boxSoup(0, 0, 5, 4, 4, 15)
  assert.deepEqual(helperVolumeCutSides(straddling, 'z', 10), { lower: true, upper: true })
})

test('a helper volume touching the plane exactly counts as on both sides', () => {
  // BambuStudio's test is inclusive (`bb.min[Z] <= 0 && bb.max[Z] >= 0`), so a volume resting
  // exactly on the plane is kept rather than dropped by a strict comparison.
  const touchingFromBelow = boxSoup(0, 0, 4, 4, 4, 10)
  assert.deepEqual(helperVolumeCutSides(touchingFromBelow, 'z', 10), { lower: true, upper: true })
})

test('helperVolumeCutSides honours the cut axis', () => {
  const rightOfX = boxSoup(20, 0, 0, 30, 4, 4)
  assert.deepEqual(helperVolumeCutSides(rightOfX, 'x', 10), { lower: false, upper: true })
  assert.deepEqual(helperVolumeCutSides(rightOfX, 'y', 10), { lower: true, upper: false })
})

test('an empty helper volume belongs to neither side', () => {
  // Carrying a volume with no geometry would attach an invisible part to every piece.
  assert.deepEqual(helperVolumeCutSides(new Float32Array(), 'z', 10), { lower: false, upper: false })
})

test('a carried volume keeps its placement RELATIVE to the half it rides on', () => {
  // The invariant the whole carry rests on. The half's mesh is rebased by `rebaseTriangleSoup`, and
  // the carried volume is shifted by that SAME offset and re-attached with an identity transform
  // into the same space, so their relative geometry is preserved exactly and there is no frame
  // left to get wrong. Get this wrong and the modifier lands somewhere else, which is worse for the
  // user than losing it.
  const half = boxSoup(0, 0, 4, 10, 10, 14)      // not resting on the bed, so offset.z is non-zero
  const volume = boxSoup(2, 3, 5, 4, 5, 7)
  const relativeBefore = [volume[0]! - half[0]!, volume[1]! - half[1]!, volume[2]! - half[2]!]

  const { offset } = rebaseTriangleSoup(half)     // mutates `half` in place
  const carried = shiftTriangleSoup(volume.slice(), offset)

  const relativeAfter = [carried[0]! - half[0]!, carried[1]! - half[1]!, carried[2]! - half[2]!]
  assert.deepEqual(relativeAfter, relativeBefore)
  // And the shift really was the half's own rebase, not a no-op.
  assert.notDeepEqual([carried[0], carried[1], carried[2]], [volume[0], volume[1], volume[2]])
})

// --- Place on cut / Flip -----------------------------------------------------------------------

/** Z of the cut face's vertices: the ones that lay exactly on the cut plane before rotating. */
function cutFaceZRange(original: Float32Array, rotated: Float32Array, axisIndex: number, value: number) {
  let min = Infinity, max = -Infinity, found = 0
  for (let i = 0; i < original.length; i += 3) {
    if (Math.abs(original[i + axisIndex]! - value) > 1e-6) continue
    found += 1
    min = Math.min(min, rotated[i + 2]!)
    max = Math.max(max, rotated[i + 2]!)
  }
  return { min, max, found }
}

function soupZRange(soup: Float32Array) {
  let min = Infinity, max = -Infinity
  for (let i = 2; i < soup.length; i += 3) { min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!) }
  return { min, max }
}

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const

for (const axis of ['x', 'y', 'z'] as const) {
  for (const side of ['lower', 'upper'] as const) {
    test(`place on cut turns the ${side} ${axis}-cut half's cut face down onto the bed`, () => {
      // A cube spanning 0..10 on every axis, cut at 4 along `axis`.
      const cube = boxSoup(0, 0, 0, 10, 10, 10)
      const halves = cutTriangleSoup(cube.slice(), axis, 4)
      const half = halves[side]
      assert.ok(half.length > 0, 'the half exists')
      const before = half.slice()
      const after = orientCutHalfSoup(half.slice(), axis, side, 'placeOnCut')

      const face = cutFaceZRange(before, after, AXIS_INDEX[axis], 4)
      assert.ok(face.found > 0, 'found the cut-face vertices')
      const body = soupZRange(after)
      // The whole cut face must sit at the piece's LOWEST Z: that is what "on the bed" means.
      assert.ok(Math.abs(face.min - body.min) < 1e-6 && Math.abs(face.max - body.min) < 1e-6,
        `cut face should be flat on the bottom: face=${face.min}..${face.max} body min=${body.min}`)
      assert.ok(body.max > body.min, 'the piece still has height')
    })
  }
}

test('keep orientation leaves the soup untouched', () => {
  const cube = boxSoup(0, 0, 0, 10, 10, 10)
  const { upper } = cutTriangleSoup(cube.slice(), 'x', 4)
  const before = upper.slice()
  const after = orientCutHalfSoup(upper, 'x', 'upper', 'keep')
  assert.deepEqual([...after], [...before])
})

test('flip turns a half upside down regardless of the cut axis', () => {
  for (const axis of ['x', 'y', 'z'] as const) {
    const cube = boxSoup(0, 0, 0, 10, 10, 10)
    const { lower } = cutTriangleSoup(cube.slice(), axis, 4)
    const before = soupZRange(lower.slice())
    const after = soupZRange(orientCutHalfSoup(lower, axis, 'lower', 'flip'))
    // Upside down about X: the Z extent mirrors through zero.
    assert.ok(Math.abs(after.min + before.max) < 1e-6, `${axis}: min`)
    assert.ok(Math.abs(after.max + before.min) < 1e-6, `${axis}: max`)
  }
})

test('orienting a half keeps it watertight and keeps its volume', () => {
  // A rotation must not invert winding: a flipped normal would make the piece unsliceable.
  for (const axis of ['x', 'y', 'z'] as const) {
    for (const orientation of ['placeOnCut', 'flip'] as const) {
      const cube = boxSoup(0, 0, 0, 10, 10, 10)
      const { upper } = cutTriangleSoup(cube.slice(), axis, 4)
      const volumeBefore = signedVolume(upper.slice())
      const rotated = orientCutHalfSoup(upper, axis, 'upper', orientation)
      assertWatertight(rotated, `${axis}/${orientation}`)
      assert.ok(Math.abs(signedVolume(rotated) - volumeBefore) < 1e-3,
        `${axis}/${orientation}: volume changed sign or magnitude (winding inverted?)`)
    }
  }
})

test('a reoriented half is placed by its PRE-rotation footprint, not its rebased centre', () => {
  // Regression: the cut places each half at its rebased XY centre to keep it where it was. Once a
  // half is rotated that centre is in the ROTATED frame, so using it as a world position threw the
  // piece off the plate — a tall model cut along X had its 230mm height become a negative X.
  const tall = boxSoup(100, 100, 0, 140, 140, 230) // a tall box standing at x,y ~100..140
  const { upper } = cutTriangleSoup(tall.slice(), 'x', 120)

  const placement = triangleSoupXYCenter(upper.slice())
  // The placement must sit inside the source model's own footprint.
  assert.ok(placement.x >= 100 && placement.x <= 140, `placement x in footprint: ${placement.x}`)
  assert.ok(placement.y >= 100 && placement.y <= 140, `placement y in footprint: ${placement.y}`)

  // Whereas the rebased centre AFTER a place-on-cut rotation is not a world position at all.
  const rotated = orientCutHalfSoup(upper.slice(), 'x', 'upper', 'placeOnCut')
  const { offset } = rebaseTriangleSoup(rotated)
  assert.ok(Math.abs(offset.x - placement.x) > 100,
    'the rotated frame centre is far from the real footprint (which is why it must not be used)')
})

test('triangleSoupXYCenter ignores Z and handles an empty soup', () => {
  assert.deepEqual(triangleSoupXYCenter(new Float32Array()), { x: 0, y: 0 })
  const box = boxSoup(-10, 20, 500, 30, 40, 900)
  assert.deepEqual(triangleSoupXYCenter(box), { x: 10, y: 30 })
})

test('triangleSoupsEqual is exact, so a real geometry change is never skipped', () => {
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  assert.equal(triangleSoupsEqual(box, box), true, 'the same array')
  assert.equal(triangleSoupsEqual(box, box.slice()), true, 'an identical copy')
  assert.equal(triangleSoupsEqual(box, boxSoup(0, 0, 0, 10, 10, 11)), false, 'a different box')
  assert.equal(triangleSoupsEqual(box, box.slice(0, box.length - 3)), false, 'a different length')
  assert.equal(triangleSoupsEqual(new Float32Array(), new Float32Array()), true, 'both empty')

  // The margin the text tool leans on: a shift smaller than any tolerance a fuzzy comparison would
  // use still reads as changed, because the callers skip staging on a `true` and a near-miss would
  // leave the saved mesh one drag behind what the viewport shows.
  const nudged = box.slice()
  nudged[0] = nudged[0]! + 1e-6
  assert.equal(triangleSoupsEqual(box, nudged), false, 'a sub-micron move is still a change')
})

// --- Arbitrary-plane cut -----------------------------------------------------------------------
// Needed by the dovetail groove, four of whose seven cuts are tilted by the flap and groove angles
// (BambuStudio's `Cut::perform_with_groove`). The properties that matter are the same ones the
// axis-aligned cut already guarantees: both halves closed, and volume conserved.

test('an oblique plane splits a box into two closed halves that conserve volume', () => {
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const { upper, lower } = cutTriangleSoupByPlane(box, {
    origin: new THREE.Vector3(5, 5, 5),
    normal: new THREE.Vector3(1, 1, 1)
  })
  assert.ok(upper.length > 0 && lower.length > 0, 'a diagonal through the centre must produce both halves')
  assertWatertight(upper, 'oblique upper')
  assertWatertight(lower, 'oblique lower')
  // The plane passes through the centre of a cube along its body diagonal, so the split is even.
  assert.ok(Math.abs(signedVolume(upper) - 500) < 1e-2, `upper volume ${signedVolume(upper)}`)
  assert.ok(Math.abs(signedVolume(lower) - 500) < 1e-2, `lower volume ${signedVolume(lower)}`)
  assert.ok(Math.abs(signedVolume(upper) + signedVolume(lower) - 1000) < 1e-2, 'volume must be conserved')
})

test('a tilted plane cuts at the angle asked for, not an axis-aligned approximation', () => {
  // 45 degrees about Y: the cut face's own normal must match the plane's, which is what a naive
  // "snap to nearest axis" would get wrong while still producing two closed halves.
  //
  // Offset off the box centre ON PURPOSE. Through (5,5,5) this plane passes exactly along two of
  // the box's edges, which is the degenerate case pinned below: vertices land ON the plane and the
  // cap cannot chain a loop through them. That is pre-existing behaviour shared with the
  // axis-aligned path, not something this plane cut introduces, so it is not what this test is for.
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const normal = new THREE.Vector3(1, 0, 1).normalize()
  const { upper, lower } = cutTriangleSoupByPlane(box, { origin: new THREE.Vector3(5, 5, 6.3), normal })
  assertWatertight(upper, '45deg upper')
  assertWatertight(lower, '45deg lower')
  assert.ok(Math.abs(signedVolume(upper) + signedVolume(lower) - 1000) < 1e-2, 'volume conserved')
  // Every upper vertex must be on the +normal side of the plane, within the cut's own epsilon.
  for (let i = 0; i + 2 < upper.length; i += 3) {
    const d = (upper[i]! - 5) * normal.x + (upper[i + 1]! - 5) * normal.y + (upper[i + 2]! - 6.3) * normal.z
    assert.ok(d > -1e-3, `upper vertex ${i / 3} sits ${d} behind the plane`)
  }
})

test('flipping the normal swaps which half is upper', () => {
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const at = new THREE.Vector3(5, 5, 5)
  const forward = cutTriangleSoupByPlane(box, { origin: at, normal: new THREE.Vector3(1, 2, 3) })
  const reversed = cutTriangleSoupByPlane(box, { origin: at, normal: new THREE.Vector3(-1, -2, -3) })
  assert.ok(Math.abs(signedVolume(forward.upper) - signedVolume(reversed.lower)) < 1e-2)
  assert.ok(Math.abs(signedVolume(forward.lower) - signedVolume(reversed.upper)) < 1e-2)
})

test('an axis-aligned normal takes the EXACT permutation path, not the rotation', () => {
  // The axis cases must stay bit-identical to the dedicated entry point. A general rotation carries
  // float error, and these soups get welded downstream; `orientCutHalfSoup` avoids trig for the same
  // reason. This is the guard against someone "simplifying" by routing everything through one path.
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  for (const [axis, normal] of [
    ['x', new THREE.Vector3(1, 0, 0)],
    ['y', new THREE.Vector3(0, 1, 0)],
    ['z', new THREE.Vector3(0, 0, 1)]
  ] as const) {
    const viaPlane = cutTriangleSoupByPlane(box, { origin: new THREE.Vector3(4, 4, 4), normal })
    const viaAxis = cutTriangleSoup(box, axis, 4)
    assert.ok(triangleSoupsEqual(viaPlane.upper, viaAxis.upper), `${axis} upper must be bit-identical`)
    assert.ok(triangleSoupsEqual(viaPlane.lower, viaAxis.lower), `${axis} lower must be bit-identical`)
  }
})

test('a non-unit normal is normalised rather than scaling the offset', () => {
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const at = new THREE.Vector3(5, 5, 5)
  const unit = cutTriangleSoupByPlane(box, { origin: at, normal: new THREE.Vector3(1, 1, 1).normalize() })
  const long = cutTriangleSoupByPlane(box, { origin: at, normal: new THREE.Vector3(17, 17, 17) })
  assert.ok(Math.abs(signedVolume(unit.upper) - signedVolume(long.upper)) < 1e-2,
    'the normal\'s length must not move the plane')
})

test('a degenerate normal yields nothing rather than throwing', () => {
  // The caller already handles "nothing to keep" for a plane that misses the mesh, so a bad plane
  // takes that same route instead of a second failure mode.
  const { upper, lower } = cutTriangleSoupByPlane(boxSoup(0, 0, 0, 10, 10, 10), {
    origin: new THREE.Vector3(5, 5, 5),
    normal: new THREE.Vector3(0, 0, 0)
  })
  assert.equal(upper.length, 0)
  assert.equal(lower.length, 0)
})

test('a plane that misses the mesh keeps everything on one side', () => {
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const { upper, lower } = cutTriangleSoupByPlane(box, {
    origin: new THREE.Vector3(50, 50, 50),
    normal: new THREE.Vector3(1, 1, 1)
  })
  assert.equal(upper.length, 0, 'nothing is above a plane beyond the mesh')
  assert.ok(Math.abs(signedVolume(lower) - 1000) < 1e-2, 'the whole box stays below it')
})

test('axisAlignedCutFor reports only genuinely axis-aligned planes', () => {
  const at = new THREE.Vector3(1, 2, 3)
  assert.deepEqual(axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(0, 0, 5) }), { axis: 'z', value: 3, flipped: false })
  assert.deepEqual(axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(9, 0, 0) }), { axis: 'x', value: 1, flipped: false })
  assert.equal(axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(1, 0, 0.001) }), null)
  // A NEGATIVE axis normal describes the same plane with the halves exchanged, which the axis path
  // CAN express now that the flip is reported. It used to be refused, which sent every plane the
  // dovetail derives from its groove frame down the rotated path for no reason.
  assert.deepEqual(axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(0, 0, -1) }), { axis: 'z', value: 3, flipped: true })
  // The tiny off-axis component a quaternion leaves behind must not defeat it.
  assert.deepEqual(
    axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(2.22e-16, 0, -1) }),
    { axis: 'z', value: 3, flipped: true }
  )
  assert.equal(axisAlignedCutFor({ origin: at, normal: new THREE.Vector3(0, 0, 0) }), null)
})

test('a negative axis normal cuts the same plane with the halves exchanged', () => {
  // Behaviour, not just classification: the flip must actually swap which side is returned, or a
  // groove would harvest the wrong piece from four of its seven cuts.
  const cube = boxSoup(0, 0, 0, 10, 10, 10)
  const up = cutTriangleSoupByPlane(cube, { origin: new THREE.Vector3(0, 0, 4), normal: new THREE.Vector3(0, 0, 1) })
  const down = cutTriangleSoupByPlane(cube, { origin: new THREE.Vector3(0, 0, 4), normal: new THREE.Vector3(0, 0, -1) })
  assert.ok(triangleSoupsEqual(up.upper, down.lower), 'the +Z upper half should be the -Z lower half')
  assert.ok(triangleSoupsEqual(up.lower, down.upper), 'the +Z lower half should be the -Z upper half')
  assert.ok(isClosedSoup(down.upper) && isClosedSoup(down.lower), 'both halves stay closed')
})

test('a plane that grazes the mesh exactly is capped no worse than the axis path', () => {
  // PINS a pre-existing limitation rather than promising a fix. A plane lying exactly along mesh
  // edges leaves vertices ON it, and the cap cannot chain a closed loop through those, so both
  // halves come back with open edges. The axis-aligned cut has always done this too: cutting the
  // same box at `x = 0` leaves 4 open edges, and at `z = 10` it leaves 4 AND loses a third of the
  // volume. The oblique path is the better-behaved of the two here, which is the only claim made.
  const box = boxSoup(0, 0, 0, 10, 10, 10)
  const grazing = cutTriangleSoupByPlane(box, {
    origin: new THREE.Vector3(5, 5, 5),
    normal: new THREE.Vector3(1, 0, 1)
  })
  assert.ok(Math.abs(signedVolume(grazing.upper) + signedVolume(grazing.lower) - 1000) < 1e-2,
    'volume is still conserved through a grazing cut, even though the caps do not close')
  const axisGrazing = cutTriangleSoup(box, 'z', 10)
  assert.ok(signedVolume(axisGrazing.upper) + signedVolume(axisGrazing.lower) < 1000,
    'the axis path loses volume on its own grazing case, so this is not a regression the plane cut adds')
})

// --- Vertices lying exactly ON the cut plane ----------------------------------------------------

/**
 * A box whose side walls are SPLIT at z=0, so a ring of vertices sits exactly on that plane and no
 * triangle spans it. This is the shape of a real failure: cutting a Tape Holder at its own midpoint
 * (the cut tool's default position) left 4034 open edges, because every boundary triangle was
 * classified wholly-upper or wholly-lower and contributed no chord, so the cap could not close.
 */
function seamedBoxSoup(): Float32Array {
  const out: number[] = []
  const [x0, y0, x1, y1] = [0, 0, 10, 10]
  for (const [za, zb] of [[-5, 0], [0, 5]] as const) {
    quad(out, [x0, y0, za], [x1, y0, za], [x1, y0, zb], [x0, y0, zb])
    quad(out, [x1, y1, za], [x0, y1, za], [x0, y1, zb], [x1, y1, zb])
    quad(out, [x0, y1, za], [x0, y0, za], [x0, y0, zb], [x0, y1, zb])
    quad(out, [x1, y0, za], [x1, y1, za], [x1, y1, zb], [x1, y0, zb])
  }
  quad(out, [x0, y0, 5], [x1, y0, 5], [x1, y1, 5], [x0, y1, 5])
  quad(out, [x0, y1, -5], [x1, y1, -5], [x1, y0, -5], [x0, y0, -5])
  return new Float32Array(out)
}

test('the seamed fixture is itself a closed solid', () => {
  // Guards the test, not the code: if the fixture were open, the assertions below would pass for
  // the wrong reason.
  const box = seamedBoxSoup()
  assertWatertight(box, 'seamed box')
  assert.ok(Math.abs(signedVolume(box) - 1000) < 1e-6, `fixture volume ${signedVolume(box)}`)
})

test('a cut through vertices lying exactly on the plane still caps both halves', () => {
  // The seam ring sits at z=0 and NO triangle spans it, so every boundary triangle is classified
  // wholly-upper or wholly-lower. Their shared on-plane edges are still the cross-section's
  // boundary, and without them the loop never closes: `triangulateCrossSection` skips unclosed
  // chains by design, so the cap silently vanishes and the half renders see-through.
  const box = seamedBoxSoup()
  const { upper, lower } = cutTriangleSoup(box, 'z', 0)
  assertWatertight(upper, 'seam upper')
  assertWatertight(lower, 'seam lower')
  assert.ok(Math.abs(signedVolume(upper) - 500) < 1e-6, `upper volume ${signedVolume(upper)}`)
  assert.ok(Math.abs(signedVolume(lower) - 500) < 1e-6, `lower volume ${signedVolume(lower)}`)
})

test('a seam that only TOUCHES the plane does not gain a spurious cap', () => {
  // The counter-case that makes the fix non-trivial. Here the box sits entirely above z=0 and its
  // bottom face rests ON the plane, so every on-plane edge has both neighbours on the same side.
  // Those edges bound nothing to cut, and recording them would inject a phantom loop.
  const resting = boxSoup(0, 0, 0, 10, 10, 10)
  const { upper, lower } = cutTriangleSoup(resting, 'z', 0)
  assert.equal(lower.length, 0, 'nothing lies below a box resting on the plane')
  assert.ok(Math.abs(signedVolume(upper) - 1000) < 1e-6, `upper volume ${signedVolume(upper)}`)
  assertWatertight(upper, 'resting box')
})

// --- Dovetail (tongue and groove) cut -----------------------------------------------------------

/**
 * A snug joint: zero clearance, so the two halves are exactly complementary and must still add up
 * to the original. The clearance case is its own test, because a shaved tongue deliberately does
 * NOT conserve volume.
 */
const SNUG = {
  depth: 3,
  width: 4,
  flapsAngle: Math.PI / 3,
  grooveAngle: 0,
  depthTolerance: 0,
  widthTolerance: 0
}

test('a dovetail cut conserves volume and leaves both halves closed', () => {
  const box = boxSoup(0, 0, 0, 20, 20, 20)
  const { upper, lower } = cutTriangleSoupWithGroove(box, 'z', 10, SNUG)
  assert.ok(upper.length > 0 && lower.length > 0, 'both halves must exist')
  // `isClosedSoup`, not the strict edge-pairing check the plain cut tests use: the halves are
  // several pieces concatenated along shared faces, exactly as BambuStudio concatenates its own, and
  // this is the predicate that decides whether our tools will accept the result.
  assert.equal(isClosedSoup(upper), true, 'the tongue half must be a closed solid')
  assert.equal(isClosedSoup(lower), true, 'the groove half must be a closed solid')
  assert.ok(Math.abs(signedVolume(upper) + signedVolume(lower) - 8000) < 1e-2,
    `volume ${signedVolume(upper)} + ${signedVolume(lower)} should be 8000`)
})

test('the tongue is an UNDERCUT: wider at its base than at its tip', () => {
  // The whole point of a dovetail. Below a right angle the flanks lean outwards so the tongue cannot
  // be lifted straight out of the groove; at exactly a right angle it is a plain rectangular groove,
  // which is the control.
  const box = boxSoup(0, 0, 0, 20, 20, 20)
  // Measured on the TONGUE piece alone, not the assembled half. A trapezoidal prism carries vertices
  // only at its corners, so sampling an intermediate height finds nothing, and sampling the shared
  // plane at its tip measures the ceiling block that also touches it.
  const widthAtZ = (soup: Float32Array, z: number) => {
    let min = Infinity, max = -Infinity
    for (let i = 0; i + 2 < soup.length; i += 3) {
      if (Math.abs(soup[i + 2]! - z) > 1e-3) continue
      min = Math.min(min, soup[i]!); max = Math.max(max, soup[i]!)
    }
    return max - min
  }
  const tongue = grooveCutPieces(box, 'z', 10, SNUG).upperParts.at(-1)!
  const base = widthAtZ(tongue, 8.5)
  const tip = widthAtZ(tongue, 11.5)
  assert.ok(base > tip + 0.5, `an undercut tongue must widen downwards (base ${base}, tip ${tip})`)
  // Studio's own geometry: a flank sits at `sideShift` on the cut plane and splays by `h/tan(flap)`
  // per millimetre away from it, so the tongue's width at height h is 2*(sideShift - h/tan).
  const sideShift = 0.5 * (4 + 3 / Math.tan(Math.PI / 3))
  const expected = (h: number) => 2 * (sideShift - h / Math.tan(Math.PI / 3))
  assert.ok(Math.abs(base - expected(-1.5)) < 0.01, `base ${base} should be ${expected(-1.5)}`)
  assert.ok(Math.abs(tip - expected(1.5)) < 0.01, `tip ${tip} should be ${expected(1.5)}`)

  const square = grooveCutPieces(box, 'z', 10, { ...SNUG, flapsAngle: Math.PI / 2 }).upperParts.at(-1)!
  assert.ok(Math.abs(widthAtZ(square, 8.5) - widthAtZ(square, 11.5)) < 0.01,
    'a right-angle flap gives straight flanks, not an undercut')
})

test('tolerances shave the TONGUE, never the groove', () => {
  // So a joint is loose by exactly what was asked for rather than by twice it.
  const box = boxSoup(0, 0, 0, 20, 20, 20)
  const snug = cutTriangleSoupWithGroove(box, 'z', 10, SNUG)
  const loose = cutTriangleSoupWithGroove(box, 'z', 10, { ...SNUG, depthTolerance: 0.3, widthTolerance: 0.4 })
  assert.ok(signedVolume(loose.upper) < signedVolume(snug.upper) - 1e-3,
    'the tongue must lose material to the clearance')
  assert.ok(Math.abs(signedVolume(loose.lower) - signedVolume(snug.lower)) < 1e-3,
    'the groove half must be untouched: the clearance comes off the tongue alone')
  assert.equal(isClosedSoup(loose.upper), true, 'a shaved tongue is still a closed solid')
})

test('a dovetail works on every axis', () => {
  const box = boxSoup(0, 0, 0, 20, 20, 20)
  for (const axis of ['x', 'y', 'z'] as const) {
    const { upper, lower } = cutTriangleSoupWithGroove(box, axis, 10, SNUG)
    assert.equal(isClosedSoup(upper), true, `${axis} upper must be closed`)
    assert.equal(isClosedSoup(lower), true, `${axis} lower must be closed`)
    assert.ok(Math.abs(signedVolume(upper) + signedVolume(lower) - 8000) < 1e-2, `${axis} volume`)
  }
})

test('a groove is sized from the model, with a 1mm floor for small ones', () => {
  // Studio's own rule (`GLGizmoAdvancedCut.cpp:2336`): half the bounding box's mean dimension over
  // 30, floored at 1mm, width four times the depth.
  assert.deepEqual(grooveDefaultsForSize({ x: 100, y: 100, z: 100 }), { depth: 5, width: 20 })
  // The floor bites on anything small: a 1mm cube would otherwise get a 0.05mm groove.
  assert.deepEqual(grooveDefaultsForSize({ x: 1, y: 1, z: 1 }), { depth: 1, width: 4 })
})

test('the size limits allow a groove far larger than the default, but never below 1mm', () => {
  const limits = grooveSizeLimitsForSize({ x: 20, y: 20, z: 20 })
  assert.equal(limits.min, 1)
  assert.equal(limits.max, 30)
  // A degenerate model must still leave the field usable rather than collapsing min onto max.
  assert.equal(grooveSizeLimitsForSize({ x: 0, y: 0, z: 0 }).max, 1)
})

test('a groove is refused only when its flanks close before reaching the mouth', () => {
  const base = { depth: 4, grooveAngle: 0, depthTolerance: 0, widthTolerance: 0 }
  // Undercut and square flanks are always fine, whatever the width.
  assert.ok(isGrooveShapeValid({ ...base, width: 1, flapsAngle: Math.PI / 3 }))
  assert.ok(isGrooveShapeValid({ ...base, width: 1, flapsAngle: Math.PI / 2 }))
  // Past a right angle the flanks lean inward and consume 2*depth/tan of width. At 120 degrees and
  // 4mm deep that is ~4.62mm, so the narrower groove has nothing left and the wider one survives.
  assert.equal(isGrooveShapeValid({ ...base, width: 4, flapsAngle: (2 * Math.PI) / 3 }), false)
  assert.ok(isGrooveShapeValid({ ...base, width: 5, flapsAngle: (2 * Math.PI) / 3 }))
})

test('the model-derived defaults actually cut a valid interlocking joint', () => {
  // Guards the seam between the two new rules: a default that the validity gate would refuse would
  // open the tool with the Cut button already disabled.
  const size = { x: 40, y: 40, z: 40 }
  const groove = { ...grooveDefaultsForSize(size), ...GROOVE_CUT_DEFAULTS }
  assert.ok(isGrooveShapeValid(groove))
  const box = boxSoup(-20, -20, 0, 20, 20, 40)
  const { upper, lower } = cutTriangleSoupWithGroove(box, 'z', 20, groove)
  assert.ok(upper.length > 0 && lower.length > 0)
  assert.ok(isClosedSoup(upper), 'the tongue half is not a closed solid')
  assert.ok(isClosedSoup(lower), 'the grooved half is not a closed solid')
})

test('the default groove on a 40mm cube at the origin is closed on every axis', () => {
  const groove = { ...grooveDefaultsForSize({ x: 40, y: 40, z: 40 }), ...GROOVE_CUT_DEFAULTS }
  const cube = boxSoup(-20, -20, 0, 20, 20, 40)
  for (const axis of ['x', 'y', 'z'] as const) {
    const { upper, lower } = cutTriangleSoupWithGroove(cube, axis, axis === 'z' ? 20 : 0, groove)
    assert.ok(isClosedSoup(upper), `${axis}: the tongue half is open at the default groove`)
    assert.ok(isClosedSoup(lower), `${axis}: the grooved half is open at the default groove`)
  }
})

test('the default groove is measured across sizes and placements, not just one cube', () => {
  // A CHARACTERISATION of the known defect (see cutTriangleSoupWithGroove), not an endorsement.
  // Testing one 40mm cube at the origin is what let an earlier note claim the defaults were safe;
  // across sizes and a plate placement they are not. Pinning the exact count means a fix fails this
  // test (update the number) and so does a regression, where a single-case test would notice
  // neither. `EditorView` refuses these cuts, so the user never receives the broken geometry.
  const failures: string[] = []
  let total = 0
  for (const size of [10, 20, 40, 60, 100, 150, 200]) {
    for (const at of ['origin', 'plate'] as const) {
      const half = size / 2
      const ox = at === 'plate' ? 128 : 0
      const oy = at === 'plate' ? 128 : 0
      const cube = boxSoup(ox - half, oy - half, 0, ox + half, oy + half, size)
      const groove = { ...grooveDefaultsForSize({ x: size, y: size, z: size }), ...GROOVE_CUT_DEFAULTS }
      for (const axis of ['x', 'y', 'z'] as const) {
        total++
        const value = axis === 'x' ? ox : axis === 'y' ? oy : half
        const { upper, lower } = cutTriangleSoupWithGroove(cube, axis, value, groove)
        if (!isClosedSoup(upper) || !isClosedSoup(lower)) failures.push(`${size}mm@${at}/${axis}`)
      }
    }
  }
  assert.equal(total, 42)
  assert.equal(
    failures.length,
    7,
    `known-defect count moved; failures are now: ${failures.join(', ')}`
  )
  // Every one is the Y axis or a 200mm model, which is the shape of the defect worth remembering.
  for (const failure of failures) {
    assert.ok(/\/y$|^200mm/.test(failure), `unexpected failure shape: ${failure}`)
  }
})

/**
 * An L-shaped prism: a 10x10x10 slab (z -10..0) carrying a 5x10x10 tower on half its top
 * (z 0..10), built as ONE closed manifold so the tower's footprint is internal and the slab's
 * remaining top face lies exactly ON the z=0 cut plane, ABUTTING the region that gets cut.
 */
function lShapeSoup(): Float32Array {
  const profile: Array<[number, number]> = [[0, -10], [10, -10], [10, 0], [5, 0], [5, 10], [0, 10]]
  const out: number[] = []
  const tri = (a: number[], b: number[], c: number[]) => out.push(...a, ...b, ...c)
  // Fanning from profile[0] is valid here: it sees every other vertex.
  for (let i = 1; i + 1 < profile.length; i++) {
    const [x0, z0] = profile[0]!, [x1, z1] = profile[i]!, [x2, z2] = profile[i + 1]!
    tri([x0, 10, z0], [x1, 10, z1], [x2, 10, z2])
    tri([x0, 0, z0], [x2, 0, z2], [x1, 0, z1])
  }
  for (let i = 0; i < profile.length; i++) {
    const [ax, az] = profile[i]!, [bx, bz] = profile[(i + 1) % profile.length]!
    tri([ax, 0, az], [bx, 0, bz], [bx, 10, bz])
    tri([ax, 0, az], [bx, 10, bz], [ax, 10, az])
  }
  return new Float32Array(out)
}

test('the L-shape fixture is itself a closed solid', () => {
  const soup = lShapeSoup()
  assert.ok(isClosedSoup(soup), 'the fixture must be watertight or the cut test proves nothing')
  assert.ok(Math.abs(Math.abs(signedVolume(soup)) - 1500) < 1e-3, 'slab 1000 + tower 500')
})

test('a cut where a coplanar face ABUTS the cut region still caps both halves', () => {
  // The slab's exposed top lies exactly on the plane and shares the x=5 edge with the tower's wall.
  // Treating every coplanar edge as already-capped dropped that edge, the outline never closed, and
  // BOTH halves came back uncapped -- the same see-through failure as a cut through on-plane
  // vertices, and one volume cannot detect: a missing cap at z = cutZ contributes exactly nothing to
  // the divergence integral, so the halves still measure 500 and 1000.
  const { upper, lower } = cutTriangleSoup(lShapeSoup(), 'z', 0)
  assert.ok(Math.abs(Math.abs(signedVolume(upper)) - 500) < 1e-3, `upper volume ${signedVolume(upper)}`)
  assert.ok(Math.abs(Math.abs(signedVolume(lower)) - 1000) < 1e-3, `lower volume ${signedVolume(lower)}`)
  assert.ok(isClosedSoup(upper), 'the tower half lost its cap')
  assert.ok(isClosedSoup(lower), 'the slab half lost its cap')
})

test('the cross-section cap is the filled cut face, lying in the plane', () => {
  // What the connector tool renders and clicks against. Without it a user aims at a section hidden
  // inside a solid model, which is placing connectors blind.
  const cube = boxSoup(-10, -10, 0, 10, 10, 20)
  const cap = capSoupForHalf(cutHalfForSide(cube, 'z', 8, 'lower'), 'z', 8, 'lower')
  assert.ok(cap.length > 0, 'a cut through a cube has a cross-section')
  for (let o = 0; o + 8 < cap.length; o += 9) {
    for (const v of [o + 2, o + 5, o + 8]) {
      assert.ok(Math.abs(cap[v]! - 8) < 1e-3, `cap vertex off the plane at z=${cap[v]}`)
    }
  }
  // A 20x20 cross-section, whatever the triangulation.
  let area = 0
  for (let o = 0; o + 8 < cap.length; o += 9) {
    const ux = cap[o + 3]! - cap[o]!, uy = cap[o + 4]! - cap[o + 1]!
    const vx = cap[o + 6]! - cap[o]!, vy = cap[o + 7]! - cap[o + 1]!
    area += Math.abs(ux * vy - uy * vx) / 2
  }
  assert.ok(Math.abs(area - 400) < 1e-2, `cap area ${area} should be 20 x 20`)
  // A plane that misses the model has no cap at all.
  assert.equal(capSoupForHalf(cutHalfForSide(cube, 'z', 40, 'lower'), 'z', 40, 'lower').length, 0)
})

test('a drilled bore is a real hole: closed, and exactly the bore\'s volume lighter', () => {
  // What makes a connector hole visible instead of a negative volume the slicer resolves later.
  // The whole point is that no boolean is involved: our evaluator returned an OPEN mesh for a
  // cylinder-in-box at every resolution from 16 to 96 sides, so a drilled half built that way could
  // never be used again as an operand and never read as watertight.
  const cube = boxSoup(-10, -10, 0, 10, 10, 20)
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = axis === 'z' ? 10 : 0
    const { upper } = cutTriangleSoup(cube, axis, value)
    const before = Math.abs(signedVolume(upper))
    const bore = connectorVolumes(
      { id: 'c', x: axis === 'x' ? value : 0, y: axis === 'y' ? value : 0, z: axis === 'z' ? value : 5,
        radius: 1.25, height: 3, radiusTolerance: 0.1, heightTolerance: 0.1,
        type: 'plug', style: 'prism', shape: 'circle' },
      axis
    ).upper.soup
    const { soup: drilled, drilled: cut } = drillBoresIntoHalf(upper, [bore], axis, value, 'upper')
    assert.deepEqual(cut, [true], `${axis}: the bore was not reported as drilled`)
    assert.ok(isClosedSoup(drilled), `${axis}: the drilled half is not a closed solid`)
    // The hole is grown by the tolerances, so it removes (r + rt)^2 * area * (h + ht), where the
    // area is the 64-gon's rather than the circle's: the bore is the polygon that was actually
    // drilled, and at 64 sides it encloses about 0.16% less than PI would claim.
    const sides = CONNECTOR_SHAPE_SIDES.circle
    const disc = (sides / 2) * Math.sin((2 * Math.PI) / sides)
    const expected = disc * (1.25 + 0.1) ** 2 * (3 + 0.1)
    const removed = before - Math.abs(signedVolume(drilled))
    assert.ok(Math.abs(removed - expected) < 1e-2, `${axis}: removed ${removed}, expected ${expected}`)
  }
})

test('drilling several bores, of every shape, leaves the half closed', () => {
  const cube = boxSoup(-10, -10, 0, 10, 10, 20)
  const { upper } = cutTriangleSoup(cube, 'z', 10)
  for (const shape of ['triangle', 'square', 'hexagon', 'circle'] as const) {
    const bores = [-5, 0, 5].map((x, index) => connectorVolumes(
      { id: `c${index}`, x, y: 0, z: 10, radius: 1.25, height: 3, radiusTolerance: 0.1,
        heightTolerance: 0.1, type: 'plug', style: 'prism', shape },
      'z'
    ).upper.soup)
    const { soup, drilled } = drillBoresIntoHalf(upper, bores, 'z', 10, 'upper')
    assert.deepEqual(drilled, [true, true, true], `${shape}: not every bore was drilled`)
    assert.ok(isClosedSoup(soup), `${shape} x3 left it open`)
  }
})

test('drilling nothing, or a bore that clips to nothing here, returns the half untouched', () => {
  // The failure mode has to cost the hole, never the part.
  const cube = boxSoup(-10, -10, 0, 10, 10, 20)
  const { upper } = cutTriangleSoup(cube, 'z', 10)
  const nothing = drillBoresIntoHalf(upper, [], 'z', 10, 'upper')
  assert.equal(nothing.soup, upper)
  assert.deepEqual(nothing.drilled, [])
  // Wholly BELOW the plane, so the upper half's share of it is empty.
  const elsewhere = boxSoup(-2, -2, 0, 2, 2, 5)
  const missed = drillBoresIntoHalf(upper, [elsewhere], 'z', 10, 'upper')
  assert.equal(missed.soup, upper, 'an undrillable bore must leave the half untouched')
  assert.deepEqual(missed.drilled, [false], 'a bore that cut nothing must not report a hole')
})

test('a bore the drill skips does not take its NEIGHBOURS\' holes down with it', () => {
  // One boolean for the whole half is what this pins. The flag decides whether the caller drops each
  // connector's negative volume, so a single skipped bore used to drop the volume of every OTHER
  // connector too -- their holes were real, but the one that was never cut lost the only description
  // it had left, and its peg on the far half then mated with solid material.
  const cube = boxSoup(-10, -10, 0, 10, 10, 20)
  const { upper } = cutTriangleSoup(cube, 'z', 10)
  const boreAt = (x: number, index: number): Float32Array => connectorVolumes(
    { ...CONNECTOR_DEFAULTS, id: `c${index}`, x, y: 0, z: 10 },
    'z'
  ).upper.soup
  const bores = [boreAt(-5, 0), boxSoup(-2, -2, 0, 2, 2, 5), boreAt(5, 2)]
  const { soup, drilled } = drillBoresIntoHalf(upper, bores, 'z', 10, 'upper')
  assert.deepEqual(drilled, [true, false, true])
  assert.ok(isClosedSoup(soup), 'a partly-drilled half must still be watertight')
})

test('the drill reads back every face the CUT calls on-plane, at plate-scale coordinates', () => {
  // The two tolerances have to come from one rule, and the rule has to be the SAME quantity. Float32
  // precision is relative, so the cut scales its on-plane test on the coordinates actually present:
  // at a 256mm plate centre that is ~1.2e-4, well past the 1e-4 floor a tolerance scaled on the
  // PLANE's own coordinate (z = 10) settles at. In that gap the cut keeps a face as its cut face
  // while the drill files it into the body, so its edges never reach the cap outline and the rebuilt
  // face is dropped or chained into a wrong loop -- with nothing thrown, since the half comes back.
  const planeZ = 10
  const delta = 1.1e-4
  // A half standing at plate coordinates whose cut face sits `delta` off the plane: within what the
  // cut accepts, past the old fixed floor.
  const half = boxSoup(240, 240, planeZ + delta, 270, 270, 20)
  assert.ok(planeEpsilonAt(270) > delta, 'fixture is void unless the CUT would call this face on-plane')
  const bore = connectorVolumes({ ...CONNECTOR_DEFAULTS, id: 'c', x: 255, y: 255, z: planeZ }, 'z').upper.soup
  const { soup, drilled } = drillBoresIntoHalf(half, [bore], 'z', planeZ, 'upper')
  assert.deepEqual(drilled, [true], 'the drill did not recognise the cut face at plate-scale coordinates')
  assert.notEqual(soup, half)
})

test('a drilled cut face carries no sliver triangles, which is what shades as a line', () => {
  // Reported from the viewport as thin dark lines across an otherwise flat cut face. The mesh is
  // watertight either way -- these are not cracks -- so closedness cannot catch it. A sliver's
  // normal is the cross product of two nearly parallel edges, so it is numerically garbage and
  // shades differently from the coplanar triangles around it.
  const box = (w: number, d: number, h: number): Float32Array => {
    const quad = (out: number[], a: number[], b: number[], c: number[], e: number[]) =>
      out.push(...a, ...b, ...c, ...a, ...c, ...e)
    const out: number[] = []
    const [x0, y0, z0, x1, y1, z1] = [-w / 2, -d / 2, 0, w / 2, d / 2, h]
    quad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1])
    quad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1])
    quad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1])
    quad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1])
    quad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])
    quad(out, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0])
    return new Float32Array(out)
  }
  const { upper } = cutTriangleSoupAtZ(box(40, 20, 40), 20)
  const bores = [-6, 0, 6].map((y, index) =>
    connectorVolumes({ ...CONNECTOR_DEFAULTS, id: `c${index}`, x: 0, y, z: 20 }, 'z').upper.soup)
  const { soup: drilled } = drillBoresIntoHalf(upper, bores, 'z', 20, 'upper')
  assert.ok(isClosedSoup(drilled), 'drilling must leave the half watertight')

  let slivers = 0
  let worstAspect = 0
  for (let offset = 0; offset + 8 < drilled.length; offset += 9) {
    const onCap = [drilled[offset + 2]!, drilled[offset + 5]!, drilled[offset + 8]!]
      .every((z) => Math.abs(z - 20) < 1e-4)
    if (!onCap) continue
    const ux = drilled[offset + 3]! - drilled[offset]!
    const uy = drilled[offset + 4]! - drilled[offset + 1]!
    const vx = drilled[offset + 6]! - drilled[offset]!
    const vy = drilled[offset + 7]! - drilled[offset + 1]!
    const area = Math.abs(ux * vy - uy * vx) / 2
    const longest = Math.max(
      Math.hypot(ux, uy),
      Math.hypot(vx, vy),
      Math.hypot(drilled[offset + 6]! - drilled[offset + 3]!, drilled[offset + 7]! - drilled[offset + 4]!)
    )
    if (area < longest * longest * 1e-4) slivers++
    if (area > 0) worstAspect = Math.max(worstAspect, (longest * longest) / area)
  }
  assert.equal(slivers, 0, `the drilled face has ${slivers} sliver triangles`)
  // At 360 sides this measured 6.8 million; the bound is loose enough not to be brittle and tight
  // enough that returning to a very fine circle fails here rather than in the viewport.
  assert.ok(worstAspect < 50_000, `worst cap aspect ratio ${Math.round(worstAspect)} is sliver territory`)
})
