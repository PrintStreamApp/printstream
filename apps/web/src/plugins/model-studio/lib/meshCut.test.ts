import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cutTriangleSoup, cutTriangleSoupAtZ, helperVolumeCutSides, orientCutHalfSoup, rebaseTriangleSoup, shiftTriangleSoup, splitTriangleSoup, triangleSoupToBinaryStl, triangleSoupXYCenter, triangleSoupsEqual } from './meshCut'

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
