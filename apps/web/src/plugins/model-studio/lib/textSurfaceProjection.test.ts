/**
 * The projection that makes text follow a surface instead of sitting flat on it.
 *
 * The case that matters is a BORE: BambuStudio's default SURFACE mode cuts the host with the text's
 * baseline plane and seats each glyph on the resulting contour, so text inside a hole wraps around
 * its wall. A cylinder is therefore the fixture -- it is the shape where "flat on the highest
 * surface" and "along the surface" give visibly different answers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  arcOffsetNearest, chainLongestLoop, chainLoops, loopLength, loopNearest, nearestFrame, reverseLoop,
  seatGlyphs, sliceSegments, suggestUp, type Segment
} from './textSurfaceProjection'

/** A closed cylinder wall of `radius` about the Z axis, as a triangle soup. */
function cylinderWall(radius: number, height: number, sides = 48): Float32Array {
  const out: number[] = []
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2
    const b = ((i + 1) / sides) * Math.PI * 2
    const [x0, y0] = [Math.cos(a) * radius, Math.sin(a) * radius]
    const [x1, y1] = [Math.cos(b) * radius, Math.sin(b) * radius]
    out.push(x0, y0, 0, x1, y1, 0, x0, y0, height)
    out.push(x1, y1, 0, x1, y1, height, x0, y0, height)
  }
  return new Float32Array(out)
}

const PLANE = { origin: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: 1 } }

test('cutting a bore yields a closed loop of the right circumference', () => {
  const segments = sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal)
  assert.ok(segments.length > 0, 'the plane cut nothing at all')
  const loop = chainLongestLoop(segments)
  // A 48-sided approximation of r=10 is a little under 2*pi*r.
  const circumference = loopLength(loop)
  assert.ok(Math.abs(circumference - 2 * Math.PI * 10) < 1.5,
    `loop length ${circumference} is not a circle of radius 10`)
})

test('glyphs seat AROUND the bore rather than in a straight line', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  // Eight glyphs of 5mm each: 40mm around a ~63mm circumference, so they spread over most of it.
  const frames = seatGlyphs(loop, Array.from({ length: 8 }, () => 5))
  assert.equal(frames.filter(Boolean).length, 8, 'glyphs fell off a CLOSED loop, which cannot happen')
  // Every glyph sits on the wall, so each is one radius from the axis.
  for (const frame of frames) {
    const radius = Math.hypot(frame!.position.x, frame!.position.y)
    assert.ok(Math.abs(radius - 10) < 0.5, `glyph sits at radius ${radius}, not on the wall`)
    assert.ok(Math.abs(frame!.position.z - 5) < 1e-6, 'glyph left the cut plane')
  }
  // The whole point: the run is not collinear. Compare the first and last tangents.
  const first = frames[0]!.tangent
  const last = frames[7]!.tangent
  const alignment = first.x * last.x + first.y * last.y + first.z * last.z
  assert.ok(alignment < 0.9, `tangents barely turned (dot ${alignment}); the text is not wrapping`)
})

test('each glyph carries the surface normal where it sits, not one shared normal', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  const frames = seatGlyphs(loop, Array.from({ length: 4 }, () => 8)).filter(Boolean)
  assert.equal(frames.length, 4)
  // On a cylinder the wall normal is radial, so it should track the glyph's own position.
  for (const frame of frames) {
    const radial = Math.hypot(frame!.position.x, frame!.position.y)
    const dotWithRadius =
      (frame!.normal.x * frame!.position.x + frame!.normal.y * frame!.position.y) / radial
    assert.ok(Math.abs(Math.abs(dotWithRadius) - 1) < 0.1,
      `normal is not radial at this point (${dotWithRadius}); glyphs would face the wrong way`)
  }
})

test('a glyph run longer than an OPEN contour drops the overflow instead of piling it up', () => {
  // Half a cylinder: an open arc rather than a loop.
  const half = cylinderWall(10, 10, 48).slice(0, Math.floor(48 / 2) * 18)
  const loop = chainLongestLoop(sliceSegments(half, PLANE.origin, PLANE.normal))
  const arc = loopLength(loop)
  assert.ok(arc > 0)
  const frames = seatGlyphs(loop, Array.from({ length: 40 }, () => 5))
  assert.ok(frames.some((frame) => frame === null), 'text ran past the end of an open contour')
})

test('a closed loop WRAPS, so a long run keeps going round', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  const frames = seatGlyphs(loop, Array.from({ length: 40 }, () => 5))
  assert.equal(frames.filter(Boolean).length, 40, 'a closed loop should never drop a glyph')
})

test('a plane that misses the mesh yields nothing rather than a degenerate frame', () => {
  const segments = sliceSegments(cylinderWall(10, 10), { x: 0, y: 0, z: 999 }, { x: 0, y: 0, z: 1 })
  assert.equal(segments.length, 0)
  assert.deepEqual(seatGlyphs(chainLongestLoop(segments), [5, 5]), [null, null])
})

test('a wrapped run is centred on the point it was placed at, not on the loop start', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  // Deliberately NOT the loop's start: the chainer seeds wherever it likes, and this is the whole
  // point of the offset -- text dragged to the far side of a bore must appear on the far side.
  const dropped = { x: -10, y: 0, z: 5 }
  const advances = [3, 3, 3, 3]
  const run = advances.reduce((sum, advance) => sum + advance, 0)
  const frames = seatGlyphs(loop, advances, arcOffsetNearest(loop, dropped) - run / 2)

  const placed = frames.filter((frame) => frame != null)
  assert.equal(placed.length, advances.length, 'the run did not fit on a closed loop')
  const mid = {
    x: (placed[1]!.position.x + placed[2]!.position.x) / 2,
    y: (placed[1]!.position.y + placed[2]!.position.y) / 2
  }
  // The middle of the run sits at the drop point, a quarter-circumference (~15.7mm) from the
  // loop's own start -- so seating from offset 0 fails this by roughly that distance.
  assert.ok(Math.hypot(mid.x - dropped.x, mid.y - dropped.y) < 1.5,
    `run centred at (${mid.x}, ${mid.y}), not at the drop point (${dropped.x}, ${dropped.y})`)
})

test('the nearest arc offset tracks the point around the loop', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  const total = loopLength(loop)
  const at = (x: number, y: number): number => arcOffsetNearest(loop, { x, y, z: 5 })
  // Four points a quarter turn apart must land a quarter of the circumference apart, in order.
  const offsets = [at(10, 0), at(0, 10), at(-10, 0), at(0, -10), at(10, 0)]
  // Wrapped, because which way round the chainer walked the loop is its own business -- a quarter
  // turn against the walk reads as three quarters with it. What must hold is that every step is the
  // SAME size and is a quarter of the way round.
  const gaps = offsets.slice(1).map((offset, index) => {
    const raw = offset - offsets[index]!
    return ((raw % total) + total) % total
  })
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - gaps[0]!) < 1.5, `steps are uneven: ${gaps.join(', ')}`)
    assert.ok(Math.abs(gap - total / 4) < 1.5 || Math.abs(gap - (3 * total) / 4) < 1.5,
      `quarter turn measured ${gap}, expected ${total / 4} or ${(3 * total) / 4}`)
  }
})

test('a loop can be oriented so text reads the right way round', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  const point = { x: 10, y: 0, z: 5 }
  const before = nearestFrame(loop, point)
  const after = nearestFrame(reverseLoop(loop), point)
  assert.ok(before && after, 'no frame near the sample point')

  // Same place and same surface, opposite travel. That travel direction IS the reading direction,
  // and reversing it inverts the glyph basis -- which is what made text come out mirrored and
  // spelled backwards on roughly half of all contours, depending on the chainer's seed.
  assert.ok(Math.hypot(before.position.x - after.position.x, before.position.y - after.position.y) < 1e-6,
    'reversing moved the frame')
  const sameNormal = before.normal.x * after.normal.x + before.normal.y * after.normal.y
  assert.ok(sameNormal > 0.99, 'reversing changed which way the surface faces')
  const dot = before.tangent.x * after.tangent.x
    + before.tangent.y * after.tangent.y
    + before.tangent.z * after.tangent.z
  assert.ok(dot < -0.99, `travel was not reversed (dot ${dot})`)
})

test('reversing a loop preserves its length and its ends', () => {
  const loop = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
  const flipped = reverseLoop(loop)
  assert.equal(flipped.length, loop.length)
  assert.ok(Math.abs(loopLength(flipped) - loopLength(loop)) < 1e-6, 'length changed')
  // The walk must still be a chain: each segment starts where the last ended.
  for (let i = 1; i < flipped.length; i += 1) {
    const previous = flipped[i - 1]!.b
    const current = flipped[i]!.a
    assert.ok(Math.hypot(previous.x - current.x, previous.y - current.y, previous.z - current.z) < 1e-3,
      `the reversed chain breaks at segment ${i}`)
  }
})

test('the loop chosen is the one under the point, not the longest in the cut', () => {
  // A big outer wall and a small bore, cut in one plane -- the shape of every real part. The bore is
  // the shorter contour, so "longest" picks the outer wall no matter where the user pointed.
  const outer = cylinderWall(40, 10)
  const bore = cylinderWall(6, 10)
  const soup = new Float32Array(outer.length + bore.length)
  soup.set(outer, 0)
  soup.set(bore, outer.length)
  const segments = sliceSegments(soup, PLANE.origin, PLANE.normal)

  const loops = chainLoops(segments)
  assert.ok(loops.length >= 2, `expected an outer wall and a bore, got ${loops.length} loop(s)`)

  // Pointing just inside the bore must select the bore, which is 34mm from the outer wall.
  const inBore = { x: 6, y: 0, z: 5 }
  const chosen = loopNearest(segments, inBore)
  const chosenLength = loopLength(chosen)
  assert.ok(Math.abs(chosenLength - 2 * Math.PI * 6) < 1.5,
    `chose a contour of length ${chosenLength}, not the bore (${2 * Math.PI * 6})`)
  assert.ok(chosenLength < loopLength(chainLongestLoop(segments)),
    'chose the longest loop, which is the bug this guards')

  // And pointing at the outer wall still selects the outer wall.
  const atOuter = loopNearest(segments, { x: 40, y: 0, z: 5 })
  assert.ok(Math.abs(loopLength(atOuter) - 2 * Math.PI * 40) < 6,
    `pointing at the outer wall chose a contour of length ${loopLength(atOuter)}`)
})

test('the cut plane is the text up direction, which is what makes a flat face come out straight', () => {
  // A wall: up is world Z, so the cut plane is horizontal and a bore cuts as a circle.
  const onWall = suggestUp({ x: 1, y: 0, z: 0 })
  assert.ok(Math.abs(onWall.z - 1) < 1e-6, `up on a vertical wall was ${JSON.stringify(onWall)}`)

  // A flat top face: up CANNOT be Z, so it lies in the horizontal plane and the cut plane is
  // vertical. That is why Studio's surface text reads straight on a flat face with no special case.
  const onTop = suggestUp({ x: 0, y: 0, z: 1 })
  assert.ok(Math.abs(onTop.z) < 1e-6, `up on a flat face was ${JSON.stringify(onTop)}`)

  // Always perpendicular to the surface, or the frame it builds is skewed and shears the glyphs.
  for (const normal of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0.6, y: 0, z: 0.8 }]) {
    const up = suggestUp(normal)
    const n = Math.hypot(normal.x, normal.y, normal.z)
    const dot = (up.x * normal.x + up.y * normal.y + up.z * normal.z) / n
    assert.ok(Math.abs(dot) < 1e-6, `up was not perpendicular to ${JSON.stringify(normal)}`)
    assert.ok(Math.abs(Math.hypot(up.x, up.y, up.z) - 1) < 1e-6, 'up was not unit length')
  }
})

test('a flat face cut by its own up plane gives a STRAIGHT contour, not a circle', () => {
  // The bug in one assertion: a horizontal plane through a disc returns its circular outline, while
  // Studio's plane -- normal = suggestUp(face normal) -- is vertical and returns a straight chord.
  const disc = cylinderWall(20, 4)
  const point = { x: 0, y: 0, z: 2 }
  const horizontal = chainLongestLoop(sliceSegments(disc, point, { x: 0, y: 0, z: 1 }))
  const studio = chainLongestLoop(sliceSegments(disc, point, suggestUp({ x: 0, y: 0, z: 1 })))

  assert.ok(loopLength(horizontal) > 100, 'the horizontal cut should be the whole circumference')
  // Two short vertical edges on opposite sides of the wall, not a circumference.
  assert.ok(loopLength(studio) < 20, `the up-plane cut measured ${loopLength(studio)}, expected a chord`)
})

test('a horizontal cut plane gives a level contour where a tilted one does not', () => {
  // Same wall, two planes. Plain `surface` takes its plane from the face, so on a tilted or domed
  // face the contour rises and falls and the letters ride it -- correct, but it reads as a ragged
  // baseline. Studio's SURFACE_HORIZONAL forces the plane to WORLD up, cutting at constant height.
  const wall = cylinderWall(20, 30)
  const point = { x: 0, y: 0, z: 15 }

  const spread = (loop: ReadonlyArray<Segment>): number => {
    const zs = loop.flatMap((segment) => [segment.a.z, segment.b.z])
    return zs.length === 0 ? 0 : Math.max(...zs) - Math.min(...zs)
  }

  const horizontal = chainLongestLoop(sliceSegments(wall, point, { x: 0, y: 0, z: 1 }))
  const tilted = chainLongestLoop(sliceSegments(wall, point, { x: 0, y: 0.6, z: 0.8 }))

  assert.ok(horizontal.length > 0 && tilted.length > 0, 'a plane cut nothing')
  assert.ok(spread(horizontal) < 1e-6, `horizontal contour was not level (spread ${spread(horizontal)})`)
  // A 20mm radius tilted by that much sweeps tens of mm of height across the run.
  assert.ok(spread(tilted) > 5, `tilted contour was level (spread ${spread(tilted)}), so this proves nothing`)
})

test('a run near the end of an open span slides to fit instead of losing letters', () => {
  // Trimming the contour to the face is what stops text marching around the part, but it creates an
  // END -- and `seatGlyphs` drops any glyph running past one. Text placed near an edge then renders
  // short: "Text" came out as "ext". Sliding the run keeps every letter on the face.
  const span = chainLongestLoop(sliceSegments(cylinderWall(10, 10), PLANE.origin, PLANE.normal))
    .slice(0, 40)
  const advances = [4, 4, 4, 4]
  const runLength = advances.reduce((sum, advance) => sum + advance, 0)
  const spanLength = loopLength(span)
  assert.ok(spanLength > runLength, 'the fixture span must be able to hold the run')

  // Ask for the run right at the far end, where half of it would hang off.
  const naive = seatGlyphs(span, advances, spanLength - 1)
  assert.ok(naive.some((frame) => frame == null), 'the fixture should drop glyphs without clamping')

  const clamped = Math.min(Math.max(spanLength - 1, 0), spanLength - runLength)
  const slid = seatGlyphs(span, advances, clamped)
  assert.equal(slid.filter(Boolean).length, advances.length, 'sliding still lost a letter')
})
