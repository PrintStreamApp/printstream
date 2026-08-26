/**
 * Laying text ALONG a surface rather than flat on top of it: BambuStudio's `SURFACE` family.
 *
 * This is the computational half of Studio's approach, which `GLGizmoText` performs by handing
 * `GenerateTextJob` a POSITION AND NORMAL PER CHARACTER (`m_position_points` / `m_normal_points`)
 * together with a cut plane (`m_cut_plane_dir_in_world`). Rather than building one flat text mesh,
 * it cuts the host with the text's baseline plane, walks the resulting contour, and seats each glyph
 * at its own arc position with that point's own normal. Run through a cylindrical bore, that contour
 * is a circle, which is why Studio's text wraps around the inside of a hole.
 *
 * Pure geometry, no three.js scene and no React, so the projection can be tested directly. What it
 * does NOT do is build meshes: the caller owns glyph geometry and simply places each glyph on the
 * frame returned here.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** One glyph's seat on the surface: where it sits and how it is turned. */
export interface GlyphFrame {
  position: Vec3
  /** Surface normal at that point; the glyph's extrusion runs along this. */
  normal: Vec3
  /** Direction of travel along the contour; the glyph's baseline runs along this. */
  tangent: Vec3
}

const EPSILON = 1e-6

function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function add(a: Vec3, b: Vec3): Vec3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z } }
function scale(a: Vec3, k: number): Vec3 { return { x: a.x * k, y: a.y * k, z: a.z * k } }
function dot(a: Vec3, b: Vec3): number { return a.x * b.x + a.y * b.y + a.z * b.z }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function length(a: Vec3): number { return Math.sqrt(dot(a, a)) }
function normalize(a: Vec3): Vec3 {
  const len = length(a)
  return len < EPSILON ? { x: 0, y: 0, z: 1 } : scale(a, 1 / len)
}

/** A segment of the cross-section, with the surface normal of the triangle that produced it. */
export interface Segment {
  a: Vec3
  b: Vec3
  normal: Vec3
}

/**
 * Intersect a triangle soup with the plane through `origin` with normal `planeNormal`, returning the
 * cut segments and the surface normal each came from.
 *
 * The normals are the point of carrying segments rather than bare points: a glyph seated on the
 * contour needs to know which way the SURFACE faces there, and that is a property of the triangle
 * the segment came from, not of the contour.
 */
export function sliceSegments(soup: Float32Array, origin: Vec3, planeNormal: Vec3): Segment[] {
  const plane = normalize(planeNormal)
  const segments: Segment[] = []
  const at = (i: number): Vec3 => ({ x: soup[i]!, y: soup[i + 1]!, z: soup[i + 2]! })

  for (let i = 0; i + 8 < soup.length; i += 9) {
    const tri = [at(i), at(i + 3), at(i + 6)]
    const distances = tri.map((point) => dot(sub(point, origin), plane))
    // Points exactly ON the plane are treated as being on the positive side, so a triangle lying in
    // the plane produces no segment rather than a degenerate one.
    const crossings: Vec3[] = []
    for (let edge = 0; edge < 3; edge += 1) {
      const d0 = distances[edge]!
      const d1 = distances[(edge + 1) % 3]!
      if ((d0 < 0) === (d1 < 0)) continue
      const t = d0 / (d0 - d1)
      crossings.push(add(tri[edge]!, scale(sub(tri[(edge + 1) % 3]!, tri[edge]!), t)))
    }
    if (crossings.length !== 2) continue
    const faceNormal = normalize(cross(sub(tri[1]!, tri[0]!), sub(tri[2]!, tri[0]!)))
    if (length(sub(crossings[1]!, crossings[0]!)) < EPSILON) continue
    segments.push({ a: crossings[0]!, b: crossings[1]!, normal: faceNormal })
  }
  return segments
}

/**
 * BambuStudio's `UP_LIMIT` (`SurfaceDrag.hpp:55`): how close to vertical a normal may be before
 * "up" has to be measured from Y rather than Z.
 */
export const UP_LIMIT = 0.9

/**
 * The text's UP direction on a surface, ported from `Emboss::suggest_up`.
 *
 * This is the value the whole surface family turns on, because Studio makes it the CUT PLANE's
 * normal (`GLGizmoText.cpp:3180` takes column 1 of the text transform, which is this). Slicing with
 * a fixed world-Z plane instead -- which is what we did -- is right only by coincidence on a
 * vertical wall, and badly wrong on a flat face: a horizontal plane through a flat shelf returns
 * that shelf's OUTLINE, so the text could only ever fan around a circle. Studio needs no
 * flat-face special case because the plane it cuts with is vertical there, and a vertical cut
 * through a flat face is a straight line.
 */
export function suggestUp(normal: Vec3, upLimit = UP_LIMIT): Vec3 {
  const n = normalize(normal)
  // Measuring "up" from Z fails when the surface already faces up, so Studio switches axes there.
  const wantedUpSide: Vec3 = Math.abs(n.z) > upLimit ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 }
  return normalize(cross(cross(n, wantedUpSide), n))
}

/**
 * Chain cut segments into ordered loops, one per connected contour.
 *
 * A cross-section through a real part yields SEVERAL: an outer silhouette, a recess wall, one per
 * bore. Which of them the text belongs on is the caller's decision and a consequential one -- see
 * {@link loopNearest}. Endpoints are matched on a quantized key because the same point arrives twice
 * from two triangles with slightly different floating-point arithmetic, which is exactly how a chain
 * silently breaks in two.
 */
export function chainLoops(segments: ReadonlyArray<Segment>): Segment[][] {
  const key = (point: Vec3): string =>
    `${Math.round(point.x / 1e-4)}:${Math.round(point.y / 1e-4)}:${Math.round(point.z / 1e-4)}`

  // Which segments touch each endpoint. Indices, not objects: a segment is walked in whichever
  // DIRECTION the chain needs, so the oriented copy is a different object from the one in the pool
  // and identity bookkeeping silently lets the walk double back on itself. That is exactly what an
  // earlier version did -- it returned a single segment where a circle was expected.
  const touching = new Map<string, number[]>()
  segments.forEach((segment, index) => {
    for (const endpoint of [key(segment.a), key(segment.b)]) {
      const list = touching.get(endpoint)
      if (list) list.push(index)
      else touching.set(endpoint, [index])
    }
  })

  const used = segments.map(() => false)
  const loops: Segment[][] = []
  for (let seed = 0; seed < segments.length; seed += 1) {
    if (used[seed]) continue
    used[seed] = true
    const chain: Segment[] = [segments[seed]!]
    let start = segments[seed]!.a
    let end = segments[seed]!.b

    // FORWARD from the seed's end.
    for (;;) {
      const next = (touching.get(key(end)) ?? []).find((index) => !used[index])
      if (next === undefined) break
      used[next] = true
      const segment = segments[next]!
      // Orient the segment so it continues FROM the current end rather than toward it.
      const oriented = key(segment.a) === key(end)
        ? segment
        : { a: segment.b, b: segment.a, normal: segment.normal }
      chain.push(oriented)
      end = oriented.b
      if (key(end) === key(start)) break
    }
    // And BACKWARD from its start. Walking only forward truncates an OPEN contour to whatever
    // happens to lie after the seed -- a seed in the middle of a run returned a single segment.
    // A closed loop hid this by coming back around to its own start.
    if (key(end) !== key(start)) {
      for (;;) {
        const previous = (touching.get(key(start)) ?? []).find((index) => !used[index])
        if (previous === undefined) break
        used[previous] = true
        const segment = segments[previous]!
        // Oriented to arrive AT the current start.
        const oriented = key(segment.b) === key(start)
          ? segment
          : { a: segment.b, b: segment.a, normal: segment.normal }
        chain.unshift(oriented)
        start = oriented.a
        if (key(start) === key(end)) break
      }
    }
    loops.push(chain)
  }
  return loops
}

/**
 * The loop the pointed-at point belongs to.
 *
 * NOT the longest one. A cut through a real part yields several loops -- an outer silhouette, a
 * recess wall, each bore -- and the longest is almost always the outer silhouette, which is nowhere
 * near the face the user pointed at. Choosing it made text "wrap something invisible": it followed a
 * contour belonging to a different part of the model entirely, at the same height.
 */
export function loopNearest(segments: ReadonlyArray<Segment>, point: Vec3): Segment[] {
  let best: { distance: number; loop: Segment[] } | null = null
  for (const loop of chainLoops(segments)) {
    const frame = nearestFrame(loop, point)
    if (!frame) continue
    const distance = length(sub(point, frame.position))
    if (!best || distance < best.distance) best = { distance, loop }
  }
  return best?.loop ?? []
}

/** The longest contour of a cut. Kept for callers with no point of interest to select by. */
export function chainLongestLoop(segments: ReadonlyArray<Segment>): Segment[] {
  let best: Segment[] = []
  for (const loop of chainLoops(segments)) if (loop.length > best.length) best = loop
  return best
}

/**
 * Seat glyphs along a contour.
 *
 * `advances` are the per-glyph advance widths in mm, in reading order; each glyph is placed at the
 * arc-length midpoint of its own advance so a run reads evenly however the contour curves. A glyph
 * whose advance runs past the end of an OPEN contour is dropped rather than piled on the last point,
 * because text that silently overlaps itself is worse than text that is visibly too long.
 */
export function seatGlyphs(
  loop: ReadonlyArray<Segment>,
  advances: ReadonlyArray<number>,
  startOffset = 0
): Array<GlyphFrame | null> {
  if (loop.length === 0) return advances.map(() => null)
  const lengths = loop.map((segment) => length(sub(segment.b, segment.a)))
  const total = lengths.reduce((sum, value) => sum + value, 0)
  if (total < EPSILON) return advances.map(() => null)
  const closed = length(sub(loop[loop.length - 1]!.b, loop[0]!.a)) < 1e-3

  const frames: Array<GlyphFrame | null> = []
  let travelled = startOffset
  for (const advance of advances) {
    const target = travelled + advance / 2
    travelled += advance
    // A closed loop wraps; an open one simply runs out.
    const distance = closed ? ((target % total) + total) % total : target
    if (!closed && (distance < 0 || distance > total)) { frames.push(null); continue }

    let remaining = distance
    let index = 0
    while (index < loop.length - 1 && remaining > lengths[index]!) {
      remaining -= lengths[index]!
      index += 1
    }
    const segment = loop[index]!
    const segmentLength = lengths[index]!
    const t = segmentLength < EPSILON ? 0 : Math.min(Math.max(remaining / segmentLength, 0), 1)
    frames.push({
      position: add(segment.a, scale(sub(segment.b, segment.a), t)),
      normal: normalize(segment.normal),
      tangent: normalize(sub(segment.b, segment.a))
    })
  }
  return frames
}

/** Total arc length of a chained loop, so a caller can tell whether its text will fit. */
export function loopLength(loop: ReadonlyArray<Segment>): number {
  return loop.reduce((sum, segment) => sum + length(sub(segment.b, segment.a)), 0)
}

/**
 * The loop walked the other way round.
 *
 * Which direction {@link chainLongestLoop} walks is an accident of which triangle it seeded from,
 * and that direction IS the text's reading direction -- so half the time text comes out mirrored and
 * spelled backwards. Callers orient the loop before seating; see {@link nearestFrame}.
 */
export function reverseLoop(loop: ReadonlyArray<Segment>): Segment[] {
  return loop.map((segment) => ({ a: segment.b, b: segment.a, normal: segment.normal })).reverse()
}

/**
 * The point on the loop nearest `point`, with the surface normal and travel direction there.
 *
 * This is the sample a caller needs to decide the two things the contour cannot tell it by itself:
 * which way is OUT of the surface, and which way round the loop reads left-to-right.
 */
export function nearestFrame(loop: ReadonlyArray<Segment>, point: Vec3): GlyphFrame | null {
  let best: { distance: number; frame: GlyphFrame } | null = null
  for (const segment of loop) {
    const edge = sub(segment.b, segment.a)
    const edgeLength = length(edge)
    if (edgeLength < EPSILON) continue
    const t = Math.min(Math.max(dot(sub(point, segment.a), edge) / (edgeLength * edgeLength), 0), 1)
    const closest = add(segment.a, scale(edge, t))
    const distance = length(sub(point, closest))
    if (!best || distance < best.distance) {
      best = {
        distance,
        frame: { position: closest, normal: normalize(segment.normal), tangent: normalize(edge) }
      }
    }
  }
  return best?.frame ?? null
}

/**
 * Arc length along the loop of the point nearest `point`.
 *
 * This is what ties wrapped text to WHERE THE USER PUT IT. {@link seatGlyphs} measures from the
 * start of the loop, and a loop starts wherever {@link chainLongestLoop} happened to seed -- an
 * arbitrary triangle, not anything the user chose. Seating from offset 0 therefore wrapped the text
 * correctly and then placed it on the far side of the model from the pointer, which reads as the
 * text jumping somewhere random rather than following the surface.
 *
 * Returns 0 for an empty loop, so a caller that skipped the fit check still gets a usable offset.
 */
export function arcOffsetNearest(loop: ReadonlyArray<Segment>, point: Vec3): number {
  let travelled = 0
  let best = { distance: Infinity, offset: 0 }
  for (const segment of loop) {
    const edge = sub(segment.b, segment.a)
    const edgeLength = length(edge)
    if (edgeLength < EPSILON) continue
    // Project onto the segment, clamped to its ends: the nearest point on a polyline lies either
    // inside a segment or at one of its joints, and clamping covers both.
    const t = Math.min(Math.max(dot(sub(point, segment.a), edge) / (edgeLength * edgeLength), 0), 1)
    const closest = add(segment.a, scale(edge, t))
    const distance = length(sub(point, closest))
    if (distance < best.distance) best = { distance, offset: travelled + t * edgeLength }
    travelled += edgeLength
  }
  return best.offset
}
