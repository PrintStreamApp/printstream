/**
 * The measurable FEATURES of a mesh: vertices, edges, circles and planes.
 *
 * Ports BambuStudio's `Measure.cpp` feature model (`SurfaceFeatureType`, `Measure.hpp:20`), which is
 * what lets its measure tool answer "how far apart are these two holes", "what angle is that
 * chamfer" and "how thick is this wall" with the same gesture. This module owns the EXTRACTION half
 * -- what features exist and which one is under the cursor; `measureBetween.ts` owns the arithmetic
 * between two of them.
 *
 * THE CENTRAL INSIGHT IS STUDIO'S, and it is what makes the whole thing tractable. Nothing here
 * recognises a cylinder, a fillet or a boss. Everything is derived from ONE decomposition:
 * `update_planes` (`Measure.cpp:132`) flood-fills facets sharing a normal into a "plane", then walks
 * that plane's border loops, and `extract_features` (`:294`) reads the features off those loops --
 * a whole round border is a circle, a round RUN inside a border is a circle, what is left is edges,
 * and the region itself is a plane. A bore through a plate is simply an inner border of the plate's
 * top face, so a pocket, a counterbore, a through-hole and a boss all fall out of the same code.
 *
 * ONE STRUCTURAL DIVERGENCE, and it is deliberate. Studio packs all four types into a single class
 * with overloaded fields -- for a circle `m_pt1` is the centre and `m_pt2` the normal, for a plane
 * `m_pt1` is the normal and `m_pt2` a point -- which its own porting notes call the easiest thing to
 * get backwards. Here they are a discriminated union, so the compiler will not let a plane's normal
 * be read as a circle's centre.
 *
 * TWO NUMERICAL DIVERGENCES, stated where they are made: the circle fit is algebraic rather than
 * RANSAC (see {@link fitCircleToLoop}), and Studio's 5-to-8-point "polygon" case is reported as a
 * circle rather than split into edges carrying a centre (see {@link circleFromBorderLoop}).
 *
 * Counterparts: `useEditorScene`'s measure hover, which picks from this, and `EditorView`'s measure
 * overlay, which draws what was picked.
 */
import * as THREE from 'three'
import { getMeasurement } from './measureBetween'

/**
 * One measurable feature, in the space its positions were given in.
 *
 * A discriminated union rather than Studio's overloaded field set -- see the module header.
 */
export type MeasureFeature =
  | { kind: 'point'; point: THREE.Vector3 }
  | {
    kind: 'edge'
    start: THREE.Vector3
    end: THREE.Vector3
    /**
     * The centre Studio attaches to the edges of a regular polygon (`Measure.cpp:333`), so a hex
     * socket's centre stays reachable even though it is described as edges. Absent on an ordinary
     * edge.
     */
    center?: THREE.Vector3
  }
  | MeshCircle
  | {
    kind: 'plane'
    planeId: number
    normal: THREE.Vector3
    /** Centre of gravity of the plane's border points, Studio's `cog` (`Measure.cpp:510`). */
    origin: THREE.Vector3
    /** Every border loop of the region, which is what the highlight draws. */
    borders: THREE.Vector3[][]
    /**
     * The region's own boundary EDGES, after collinear merging.
     *
     * Carried on the feature because measuring an edge or a circle against a plane is done against
     * these rather than against the plane's infinite extent -- so the answer describes the face the
     * user can see, not the mathematical plane behind it. Studio keeps the same list on the feature
     * (`world_plane_features`, `Measure.hpp:102`), populated by the GUI before it measures; here it
     * is filled in at extraction so a plane feature is complete on its own.
     */
    edges: Array<[THREE.Vector3, THREE.Vector3]>
  }

/** A circular or regular-polygonal border loop, in the space its positions were given in. */
export interface MeshCircle {
  kind: 'circle'
  /** Centre of the fitted circle. This is the point the measure tool snaps to. */
  center: THREE.Vector3
  /** Plane normal of the face this loop bounds. */
  normal: THREE.Vector3
  radius: number
  /** The loop's own vertices, so a caller draws the rim that was detected, not an idealised one. */
  rim: THREE.Vector3[]
}

/**
 * How nearly parallel two face normals must be to count as ONE plane.
 *
 * Studio's `is_same_normal` compares each component against 0.001 (`Measure.cpp:145`). Kept as a
 * per-component bound rather than an angle so a mesh Studio groups one way cannot group differently
 * here: on a curved wall the two rules disagree about where a plane ends, and that decides which
 * loops are borders at all.
 */
const SAME_NORMAL_EPSILON = 0.001

/**
 * Largest fit residual still called a circle (Studio's `err < 0.05`, `Measure.cpp:323`).
 *
 * MILLIMETRES, and an L-infinity residual: the worst single point's radial deviation, not an
 * average. Matching the NORM matters as much as matching the number -- an RMS residual is always
 * the smaller of the two, so comparing one against Studio's threshold quietly accepts loops Studio
 * rejects, and the shapes that differ are exactly the ones with a few bad points among many good
 * ones (a rounded rectangle, a hole with a nick in it).
 */
const MAX_CIRCLE_FIT_ERROR = 0.05

/**
 * Tolerance on consecutive edge lengths, Studio's `is_approx(..., 0.01)` (`Measure.cpp:327`).
 *
 * ABSOLUTE, and applied to SQUARED lengths, which is what Studio compares. Both details are load
 * bearing: squaring makes the test scale with the feature (a 0.01 slack on squared millimetres is
 * far tighter for a big loop than for a small one), which is what stops a large rounded rectangle
 * passing as a circle.
 */
const EDGE_LENGTH_TOLERANCE = 0.01

/** Quantum (mm) for matching loop endpoints, the same the cut tool chains cross-sections with. */
const CHAIN_QUANTUM = 1e-4

/**
 * Tolerance on consecutive TURN ANGLES when hunting a circular run inside a border, in RADIANS
 * (Studio's `are_angles_same`, `Measure.cpp:349`), and on the edge lengths within that run, in
 * millimetres (`are_lengths_same`, `:350`). Absolute, both of them.
 */
const ARC_ANGLE_TOLERANCE = 0.01
const ARC_LENGTH_TOLERANCE = 0.01

/** Fewest vertices Studio will call an arc (`single_circle.size() >= 5`, `Measure.cpp:418`). */
const MIN_ARC_POINTS = 5

/**
 * Shortest arc worth reporting, as arc length over radius: Studio's `0.9 * M_PI / 2` (`:443`), about
 * 81 degrees. A shallower run is a fillet or a rounded corner rather than a feature with a centre
 * anyone means to measure from.
 */
const MIN_ARC_SUBTENDED = 0.9 * Math.PI / 2

/**
 * How nearly parallel two edges must be before they are merged into one.
 *
 * Studio compares the dot product of the unit directions against 1 with its default `EPSILON` of
 * 1e-4 (`Measure.cpp:481`). Without this a chamfer tessellated into a run of collinear segments
 * offers a dozen separate edges where the user sees one line.
 */
const COLLINEAR_EDGE_EPSILON = 1e-4

/**
 * One mesh's coplanar regions, and the features found on each.
 *
 * Built once per mesh and cached by the caller, as Studio builds one `Measuring` per volume
 * (`GLGizmoMeasure.cpp:2664`), because it walks every face and every edge. The features of a given
 * plane are extracted only when that plane is first hovered -- Studio defers the same way
 * ("Extracting features will be done as needed", `Measure.cpp:123`) -- so pointing at a model costs
 * one pass over its faces, then nothing until the cursor crosses onto a face of another plane.
 *
 * Everything here is in the MESH'S OWN space. Studio does the same and applies the volume's world
 * transform to the feature it returns; keeping it local is what lets the index survive a move,
 * rotate or scale of the object without being rebuilt.
 */
export interface MeshCircleIndex {
  positions: Float32Array
  /** Plane id per face index. */
  planeOfFace: Int32Array
  /** Face indices per plane. */
  facesOfPlane: number[][]
  /** Unit normal per plane. */
  normals: THREE.Vector3[]
  /** Opposite face across each (face, side), or -1 where the edge is not cleanly manifold. */
  adjacency: Int32Array
  /** Features per plane, extracted on first use. */
  features: Array<MeasureFeature[] | undefined>
}

/**
 * Face adjacency across shared edges.
 *
 * Vertices are matched BIT-EXACTLY, no tolerance, for the reason `isClosedSoup` states: viewport
 * geometry arrives already welded (`meshParseCore` merges vertices and then de-indexes by COPYING
 * each merged one), so exact keys recover the original connectivity exactly. A tolerance here would
 * answer a different question and would join features that are genuinely apart.
 */
function buildFaceAdjacency(positions: Float32Array, faceCount: number): Int32Array {
  const vertexKey = (face: number, corner: number): string => {
    const o = face * 9 + corner * 3
    return `${positions[o]},${positions[o + 1]},${positions[o + 2]}`
  }
  const edges = new Map<string, number[]>()
  for (let face = 0; face < faceCount; face++) {
    for (let side = 0; side < 3; side++) {
      const a = vertexKey(face, side)
      const b = vertexKey(face, (side + 1) % 3)
      if (a === b) continue
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      const uses = edges.get(key)
      if (uses) uses.push(face * 3 + side)
      else edges.set(key, [face * 3 + side])
    }
  }
  const neighbours = new Int32Array(faceCount * 3).fill(-1)
  for (const uses of edges.values()) {
    // Only a cleanly manifold edge yields a neighbour. An edge shared by three faces has no single
    // opposite, and picking one would let the plane flood-fill leak across a seam into geometry
    // that is not part of this face -- which shows up as a hole's rim never closing.
    if (uses.length !== 2) continue
    const [first, second] = uses as [number, number]
    neighbours[first] = Math.floor(second / 3)
    neighbours[second] = Math.floor(first / 3)
  }
  return neighbours
}

function faceNormal(positions: Float32Array, face: number, out: THREE.Vector3): THREE.Vector3 {
  const o = face * 9
  const ax = positions[o]!, ay = positions[o + 1]!, az = positions[o + 2]!
  const ux = positions[o + 3]! - ax, uy = positions[o + 4]! - ay, uz = positions[o + 5]! - az
  const vx = positions[o + 6]! - ax, vy = positions[o + 7]! - ay, vz = positions[o + 8]! - az
  return out.set(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx).normalize()
}

/**
 * Group every face of a triangle soup into a coplanar region: Studio's `update_planes`.
 *
 * `positions` is a non-indexed soup, three vertices per face, which is what this plugin's viewport
 * geometry and `collectWorldTriangles` both are.
 */
export function buildMeshCircleIndex(positions: Float32Array): MeshCircleIndex {
  const faceCount = Math.floor(positions.length / 9)
  const adjacency = buildFaceAdjacency(positions, faceCount)
  const planeOfFace = new Int32Array(faceCount).fill(-1)
  const facesOfPlane: number[][] = []
  const normals: THREE.Vector3[] = []
  const normal = new THREE.Vector3()
  const seedNormal = new THREE.Vector3()

  for (let seed = 0; seed < faceCount; seed++) {
    if (planeOfFace[seed] !== -1) continue
    faceNormal(positions, seed, seedNormal)
    const planeId = facesOfPlane.length
    facesOfPlane.push([])
    normals.push(seedNormal.clone())
    planeOfFace[seed] = planeId
    const queue = [seed]
    while (queue.length > 0) {
      const face = queue.pop()!
      facesOfPlane[planeId]!.push(face)
      for (let side = 0; side < 3; side++) {
        const next = adjacency[face * 3 + side]!
        if (next < 0 || planeOfFace[next] !== -1) continue
        faceNormal(positions, next, normal)
        if (Math.abs(normal.x - seedNormal.x) > SAME_NORMAL_EPSILON) continue
        if (Math.abs(normal.y - seedNormal.y) > SAME_NORMAL_EPSILON) continue
        if (Math.abs(normal.z - seedNormal.z) > SAME_NORMAL_EPSILON) continue
        planeOfFace[next] = planeId
        queue.push(next)
      }
    }
  }
  return { positions, planeOfFace, facesOfPlane, normals, adjacency, features: facesOfPlane.map(() => undefined) }
}

/**
 * The border loops of one plane: its edges that no second face of the SAME plane shares.
 *
 * Studio walks these with a half-edge structure (`Measure.cpp:197`); chaining the odd edges yields
 * the same loops without that traversal's failure modes, and it is the shape the cut tool already
 * uses for cross-sections. An outer silhouette and every hole through the face come back as
 * separate loops, which is exactly the distinction the caller wants.
 */
function planeBorderLoops(index: MeshCircleIndex, planeId: number): THREE.Vector3[][] {
  const { positions, adjacency } = index
  const faces = index.facesOfPlane[planeId]!
  const inPlane = new Set(faces)
  const key = (o: number): string =>
    `${Math.round(positions[o]! / CHAIN_QUANTUM)}:`
    + `${Math.round(positions[o + 1]! / CHAIN_QUANTUM)}:`
    + `${Math.round(positions[o + 2]! / CHAIN_QUANTUM)}`
  const segments: Array<{ from: string; to: string; point: THREE.Vector3 }> = []
  for (const face of faces) {
    for (let side = 0; side < 3; side++) {
      const next = adjacency[face * 3 + side]!
      if (next >= 0 && inPlane.has(next)) continue
      const oa = face * 9 + side * 3
      const ob = face * 9 + ((side + 1) % 3) * 3
      segments.push({
        from: key(oa),
        to: key(ob),
        point: new THREE.Vector3(positions[oa]!, positions[oa + 1]!, positions[oa + 2]!)
      })
    }
  }
  return chainSegmentLoops(segments)
}

/**
 * Chain border segments into closed loops, dropping any chain that does not close.
 *
 * Walked in the winding direction the faces gave, so a loop's points come out in order around it --
 * which the edge-length test below depends on, since consecutive points must be adjacent.
 */
function chainSegmentLoops(
  segments: ReadonlyArray<{ from: string; to: string; point: THREE.Vector3 }>
): THREE.Vector3[][] {
  const outgoing = new Map<string, number[]>()
  segments.forEach((segment, segmentIndex) => {
    const list = outgoing.get(segment.from)
    if (list) list.push(segmentIndex)
    else outgoing.set(segment.from, [segmentIndex])
  })
  const used = new Array<boolean>(segments.length).fill(false)
  const loops: THREE.Vector3[][] = []
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue
    const first = segments[start]!
    const loop: THREE.Vector3[] = [first.point]
    used[start] = true
    let cursor = first.to
    let closed = false
    // Bounded by the segment count: a malformed border must end the walk rather than spin here.
    for (let step = 0; step < segments.length; step++) {
      if (cursor === first.from) { closed = true; break }
      const nextIndex = outgoing.get(cursor)?.find((candidate) => !used[candidate])
      if (nextIndex === undefined) break
      used[nextIndex] = true
      const segment = segments[nextIndex]!
      loop.push(segment.point)
      cursor = segment.to
    }
    if (closed && loop.length > 2) loops.push(loop)
  }
  return loops
}

/**
 * Least-squares circle through coplanar points, with the residual that decides whether it is one.
 *
 * DIVERGENCE FROM STUDIO, deliberately. Studio fits with RANSAC (`Geometry::circle_ransac`), whose
 * centre is the circumcentre of three SAMPLED points, because its other caller feeds it partial
 * borders containing non-circular runs, where outliers must be rejected. Every loop reaching this
 * port is a complete border, so an algebraic fit over all of it is both better conditioned and
 * deterministic -- Studio's re-seeds `std::mt19937` on every call and takes only 2 to 6 iterations,
 * so its centre depends on which three points it happened to draw.
 *
 * The RESIDUAL, though, is Studio's exactly: the maximum absolute radial deviation, not an RMS,
 * because {@link MAX_CIRCLE_FIT_ERROR} is calibrated against that norm. The radius is likewise the
 * MEAN distance from the centre rather than a fitted parameter, as `circle_ransac` computes it.
 */
export function fitCircleToLoop(points: ReadonlyArray<THREE.Vector3>, normal: THREE.Vector3):
{ center: THREE.Vector3; radius: number; error: number } | null {
  if (points.length < 3) return null
  // An orthonormal frame on the plane, so the fit is a 2D problem.
  const seed = Math.abs(normal.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(normal, seed).normalize()
  const v = new THREE.Vector3().crossVectors(normal, u).normalize()
  const origin = points[0]!

  // Kasa's fit: minimising |p - c|^2 - r^2 over the points is LINEAR in (cx, cy, r^2 - |c|^2), so it
  // solves as a 2x2 system once the third unknown is eliminated by centring on the mean.
  const local: Array<[number, number]> = []
  const offset = new THREE.Vector3()
  let sx = 0, sy = 0
  for (const point of points) {
    offset.subVectors(point, origin)
    const x = offset.dot(u)
    const y = offset.dot(v)
    local.push([x, y])
    sx += x
    sy += y
  }
  const n = local.length
  const mx = sx / n
  const my = sy / n
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0
  for (const [x, y] of local) {
    const du = x - mx
    const dv = y - my
    suu += du * du
    svv += dv * dv
    suv += du * dv
    suuu += du * du * du
    svvv += dv * dv * dv
    suvv += du * dv * dv
    svuu += dv * du * du
  }
  const det = suu * svv - suv * suv
  // Collinear points have no circle through them; saying so beats returning an arbitrary one.
  if (Math.abs(det) < 1e-12) return null
  const b1 = (suuu + suvv) / 2
  const b2 = (svvv + svuu) / 2
  const cu = (b1 * svv - b2 * suv) / det
  const cv = (suu * b2 - suv * b1) / det
  const cx = cu + mx
  const cy = cv + my

  let radius = 0
  for (const [x, y] of local) radius += Math.hypot(x - cx, y - cy)
  radius /= n
  if (!(radius > 0)) return null
  let error = 0
  for (const [x, y] of local) error = Math.max(error, Math.abs(Math.hypot(x - cx, y - cy) - radius))
  return {
    center: origin.clone().addScaledVector(u, cx).addScaledVector(v, cy),
    radius,
    error
  }
}

/**
 * Whether every edge of the loop is the same length: Studio's `lengths_match` (`Measure.cpp:326`).
 *
 * Compares SQUARED lengths against an absolute tolerance, and starts at the third point so the
 * closing edge is never compared -- both are Studio's, and the second is not an oversight worth
 * correcting: a border walk can leave the closing edge a different length without the shape being
 * any less round.
 */
function edgeLengthsMatch(points: ReadonlyArray<THREE.Vector3>): boolean {
  if (points.length < 3) return false
  for (let i = 2; i < points.length; i++) {
    const here = points[i]!.distanceToSquared(points[i - 1]!)
    const previous = points[i - 1]!.distanceToSquared(points[i - 2]!)
    if (Math.abs(here - previous) > EDGE_LENGTH_TOLERANCE) return false
  }
  return true
}

/**
 * Decide whether one border loop is a circle, and where its centre is.
 *
 * Exported for the tests, which check the accept/reject boundary directly rather than through a
 * mesh: what makes this worth having is what it REFUSES, and a fixture presenting only round holes
 * cannot show that.
 *
 * DIVERGENCE: Studio splits a passing loop at 8 points -- more than 8 becomes a `Circle`, 5 to 8
 * becomes edges that merely CARRY the centre as an extra point (`Measure.cpp:333`). Both give the
 * user a centre to click, and once the answer is a point the distinction is invisible, so a hex
 * socket is reported here as the circle through its corners rather than as six edges.
 */
export function circleFromBorderLoop(points: ReadonlyArray<THREE.Vector3>, normal: THREE.Vector3): MeshCircle | null {
  // Studio will not even fit at 4 points or fewer (`Measure.cpp:321`): a triangle or a quad is a
  // shape rather than a hole, and a circle through four points always fits perfectly.
  if (points.length <= 4) return null
  const fit = fitCircleToLoop(points, normal)
  if (!fit || fit.error >= MAX_CIRCLE_FIT_ERROR) return null
  // A good fit alone is not enough: equal edges are what separate a bore or a hex socket from a
  // rounded rectangle whose corner arcs happen to sit near one circle.
  if (!edgeLengthsMatch(points)) return null
  return { kind: 'circle', center: fit.center, normal: normal.clone(), radius: fit.radius, rim: points.map((point) => point.clone()) }
}

/** Wrap an index into a closed loop, Studio's `offset_to_index` (`Measure.cpp:356`). */
function wrapIndex(index: number, offset: number, length: number): number {
  return ((index + offset) % length + length) % length
}

/**
 * The circular RUNS inside one border, and the spans they occupy.
 *
 * Studio's second extraction path (`Measure.cpp:345`), for a border that is only partly round: the
 * outline of a slot, a plate with a filleted corner, a face whose edge is broken by an arc. It walks
 * the loop accumulating runs whose consecutive TURN ANGLES agree, which is what a polygonised arc
 * looks like from the inside -- a constant angle per step -- and then holds each run to the same
 * bar a whole border must clear, plus a minimum sweep.
 *
 * The scan deliberately starts one past the first angle CHANGE rather than at index 0
 * (`first_pt_idx`, `:400`): a run that straddles the loop's arbitrary start would otherwise be seen
 * as two short runs and rejected twice.
 */
function arcsInBorder(border: ReadonlyArray<THREE.Vector3>, normal: THREE.Vector3):
Array<{ circle: MeshCircle; from: number; to: number }> {
  const count = border.length
  if (count < MIN_ARC_POINTS) return []
  const angles: number[] = []
  const lengths: number[] = []
  let firstDifferentAngle = 0
  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  const cross = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    v2.subVectors(border[i]!, border[wrapIndex(i, -1, count)]!)
    v1.subVectors(border[wrapIndex(i, 1, count)]!, border[i]!)
    cross.crossVectors(v1, v2)
    let angle = Math.atan2(-normal.dot(cross), -v1.dot(v2)) + Math.PI
    if (angle > Math.PI) angle = 2 * Math.PI - angle
    angles.push(angle)
    lengths.push(v2.length())
    if (firstDifferentAngle === 0 && angles.length > 1
      && Math.abs(angles[angles.length - 1]! - angles[angles.length - 2]!) > ARC_ANGLE_TOLERANCE) {
      firstDifferentAngle = angles.length - 1
    }
  }

  const found: Array<{ circle: MeshCircle; from: number; to: number }> = []
  const firstPoint = wrapIndex(firstDifferentAngle, 1, count)
  let run: THREE.Vector3[] = []
  let runLength = 0
  let startIndex = -1
  let inRun = false
  let i = firstPoint
  let firstIteration = true
  while (i !== firstPoint || firstIteration) {
    firstIteration = false
    const sameAngle = Math.abs(angles[i]! - angles[wrapIndex(i, -1, count)]!) <= ARC_ANGLE_TOLERANCE
    if (sameAngle && i !== wrapIndex(firstPoint, -1, count) && i !== startIndex) {
      if (!inRun) {
        inRun = true
        startIndex = wrapIndex(i, -2, count)
        run = [border[startIndex]!, border[wrapIndex(startIndex, 1, count)]!]
        runLength = lengths[wrapIndex(i, -1, count)]!
      }
      run.push(border[i]!)
      runLength += lengths[i]!
    } else {
      if (inRun && run.length >= MIN_ARC_POINTS) {
        run.push(border[i]!)
        runLength += lengths[i]!
        // The INTERIOR edges must match in length; the run's first and last are whatever the
        // straight parts either side left behind, which is why Studio starts this walk three past
        // the run's own start.
        let lengthsMatch = true
        for (let j = wrapIndex(startIndex, 3, count); j !== i; j = wrapIndex(j, 1, count)) {
          if (Math.abs(lengths[wrapIndex(j, -1, count)]! - lengths[j]!) > ARC_LENGTH_TOLERANCE) {
            lengthsMatch = false
            break
          }
        }
        const fit = lengthsMatch ? fitCircleToLoop(run, normal) : null
        if (fit && fit.error < MAX_CIRCLE_FIT_ERROR && runLength / fit.radius > MIN_ARC_SUBTENDED) {
          found.push({
            circle: {
              kind: 'circle',
              center: fit.center,
              normal: normal.clone(),
              radius: fit.radius,
              rim: run.map((point) => point.clone())
            },
            from: startIndex,
            to: i
          })
        }
      }
      inRun = false
    }
    i = wrapIndex(i, 1, count)
  }
  return found
}

/** Merge runs of collinear edges, so a tessellated straight line is ONE edge (`Measure.cpp:481`). */
function mergeCollinearEdges(edges: MeasureFeature[]): MeasureFeature[] {
  const merged: MeasureFeature[] = []
  for (const edge of edges) {
    const previous = merged[merged.length - 1]
    if (edge.kind !== 'edge' || previous?.kind !== 'edge' || !previous.end.equals(edge.start)) {
      merged.push(edge)
      continue
    }
    const a = new THREE.Vector3().subVectors(previous.end, previous.start).normalize()
    const b = new THREE.Vector3().subVectors(edge.end, edge.start).normalize()
    if (Math.abs(a.dot(b) - 1) > COLLINEAR_EDGE_EPSILON) {
      merged.push(edge)
      continue
    }
    merged[merged.length - 1] = { kind: 'edge', start: previous.start, end: edge.end }
  }
  return merged
}

/**
 * Every feature of one coplanar region: its circles, its edges, and the plane itself.
 *
 * The plane is appended LAST, and Studio relies on that in two places (`Measure.cpp:545`, `:548`):
 * the hover search walks all but the final entry, so that a face always resolves to SOMETHING
 * without the plane winning over the edge the cursor is actually near.
 */
export function featuresForPlane(index: MeshCircleIndex, planeId: number): MeasureFeature[] {
  const cached = index.features[planeId]
  if (cached) return cached
  const normal = index.normals[planeId]!
  const borders = planeBorderLoops(index, planeId)
  const features: MeasureFeature[] = []
  const edges: MeasureFeature[] = []

  for (const border of borders) {
    if (border.length <= 1) continue
    const whole = circleFromBorderLoop(border, normal)
    if (whole) {
      features.push(whole)
      continue
    }
    // Not round as a whole; it may still contain arcs, and whatever is left over is edges.
    const arcs = arcsInBorder(border, normal)
    for (const arc of arcs) features.push(arc.circle)
    const insideArc = new Set<number>()
    for (const arc of arcs) {
      for (let i = arc.from; i !== arc.to; i = wrapIndex(i, 1, border.length)) insideArc.add(i)
    }
    for (let i = 0; i < border.length; i++) {
      if (insideArc.has(i)) continue
      edges.push({ kind: 'edge', start: border[i]!, end: border[wrapIndex(i, 1, border.length)]! })
    }
  }
  features.push(...mergeCollinearEdges(edges))

  const cog = new THREE.Vector3()
  let borderPoints = 0
  for (const border of borders) {
    for (const point of border) {
      cog.add(point)
      borderPoints++
    }
  }
  if (borderPoints > 0) cog.divideScalar(borderPoints)
  const planeEdges = features.flatMap((feature): Array<[THREE.Vector3, THREE.Vector3]> =>
    feature.kind === 'edge' ? [[feature.start, feature.end]] : [])
  features.push({ kind: 'plane', planeId, normal: normal.clone(), origin: cog, borders, edges: planeEdges })

  index.features[planeId] = features
  return features
}

/**
 * The circles bounding the flat region that `faceIndex` belongs to.
 *
 * Both the outer silhouette and every hole through that face are candidates: a round boss reads as a
 * circle exactly as a bore does, and to the measure tool they are the same question -- where is the
 * centre of that round thing?
 */
export function circlesAroundFace(index: MeshCircleIndex, faceIndex: number): MeshCircle[] {
  const planeId = index.planeOfFace[faceIndex]
  if (planeId === undefined || planeId < 0) return []
  return featuresForPlane(index, planeId).filter((feature): feature is MeshCircle => feature.kind === 'circle')
}

/**
 * Studio's own hover reach, `feature_hover_limit` (`Measure.cpp:42`), in MODEL millimetres.
 *
 * Exported as the reference value rather than used directly: it is not scale-aware, which Studio's
 * porting notes flag, so at any zoomed-out view 0.5mm is sub-pixel and nothing is reachable. The
 * caller converts a screen-pixel budget into model units instead -- the same divergence the hole
 * snap already makes, kept identical so the two cannot disagree about what "near" means.
 */
export const STUDIO_FEATURE_HOVER_LIMIT = 0.5

/**
 * How close to an edge's END the cursor must be for the ENDPOINT to be picked instead of the edge.
 *
 * Studio's rule (`Measure.cpp:563`): a tenth of the edge's length, clamped to between 0.025mm and
 * 0.5mm. Deliberately absolute rather than scale-aware, and it should stay that way -- it describes
 * a proportion of the FEATURE, not a distance on screen, so a corner stays as easy to hit on a long
 * edge as on a short one.
 */
const EDGE_ENDPOINT_MIN_SNAP = 0.025
const EDGE_ENDPOINT_MAX_SNAP = 0.5
const EDGE_ENDPOINT_SNAP_FRACTION = 0.1

/**
 * The feature under the cursor: Studio's `MeasuringImpl::get_feature` (`Measure.cpp:529`).
 *
 * `point` is in the MESH'S OWN space, as is `hoverLimit`, because that is the space the index holds.
 * The caller converts both from world coordinates, which is what lets the index survive a move or a
 * scale of the object.
 *
 * Three rules, all Studio's. The nearest feature wins by MEASURED distance rather than by any
 * proximity heuristic, so a hole's rim beats the face it sits in without either needing to know
 * about the other. Only `distanceStrict` counts, which quietly excludes the plane -- point-to-plane
 * reports an infinite distance and nothing else -- so the face can never win over a feature on it.
 * And nothing within reach falls back to the PLANE, so a face always resolves to something rather
 * than to nothing.
 */
export function featureAtFace(
  index: MeshCircleIndex,
  faceIndex: number,
  point: THREE.Vector3,
  hoverLimit = STUDIO_FEATURE_HOVER_LIMIT
): MeasureFeature | null {
  const planeId = index.planeOfFace[faceIndex]
  if (planeId === undefined || planeId < 0) return null
  const features = featuresForPlane(index, planeId)
  if (features.length === 0) return null

  const probe: MeasureFeature = { kind: 'point', point }
  let closest: MeasureFeature | null = null
  let minDistance = Infinity
  // The last entry is the plane itself, and it is skipped: measuring the cursor against the face it
  // is already on answers nothing and is the most expensive pair in the table.
  for (let i = 0; i < features.length - 1; i++) {
    const strict = getMeasurement(features[i]!, probe).distanceStrict
    if (!strict) continue
    if (strict.dist < hoverLimit && strict.dist < minDistance) {
      minDistance = strict.dist
      closest = features[i]!
    }
  }

  if (!closest) return features[features.length - 1]!
  if (closest.kind !== 'edge') return closest
  // Near an end of the edge, the CORNER is what the user is pointing at. Without this an edge is
  // easier to hit than the vertex it ends at, which makes a corner-to-corner measurement need a
  // pixel-perfect aim.
  const lengthSquared = closest.start.distanceToSquared(closest.end)
  const limitSquared = Math.max(
    EDGE_ENDPOINT_MIN_SNAP ** 2,
    Math.min(EDGE_ENDPOINT_MAX_SNAP ** 2, EDGE_ENDPOINT_SNAP_FRACTION ** 2 * lengthSquared)
  )
  if (point.distanceToSquared(closest.start) < limitSquared) return { kind: 'point', point: closest.start.clone() }
  if (point.distanceToSquared(closest.end) < limitSquared) return { kind: 'point', point: closest.end.clone() }
  return closest
}

/**
 * Move a feature from the mesh's own space into world space.
 *
 * Features are extracted and cached in LOCAL space precisely so this can be applied per hover
 * instead of the index being rebuilt whenever the object moves.
 *
 * DIVERGENCE, and a deliberate one. Studio carries a normal as the difference between two
 * transformed points (`Measure.cpp:1399`), which transforms it as a DIRECTION. That is correct for
 * a rotation or a uniform scale and wrong for anything else: a surface normal transforms by the
 * INVERSE TRANSPOSE, and under a non-uniform scale the two answers differ. Squash a 45-degree face
 * to a quarter of its height and the surface tilts toward horizontal, so its normal should tilt
 * toward +Z -- Studio's rule tilts it the other way. Every angle, every parallel test and every
 * coplanarity test downstream then reads off a normal pointing somewhere the surface does not face.
 * This editor offers per-axis scaling, so that is reachable rather than theoretical, and the two
 * rules agree wherever Studio is right, so parity is only broken where it was wrong.
 *
 * A RADIUS is re-derived Studio's way, by transforming a point that is actually on the rim and
 * measuring: under a non-uniform scale a circle stops being one, and what that radius became is as
 * honest an answer as exists.
 */
export function transformMeasureFeature(feature: MeasureFeature, matrix: THREE.Matrix4): MeasureFeature {
  const at = (point: THREE.Vector3) => point.clone().applyMatrix4(matrix)
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
  const normalAt = (normal: THREE.Vector3) => normal.clone().applyMatrix3(normalMatrix).normalize()
  switch (feature.kind) {
    case 'point':
      return { kind: 'point', point: at(feature.point) }
    case 'edge':
      return {
        kind: 'edge',
        start: at(feature.start),
        end: at(feature.end),
        ...(feature.center ? { center: at(feature.center) } : {})
      }
    case 'circle': {
      const center = at(feature.center)
      const normal = normalAt(feature.normal)
      // A point genuinely on the rim, carried through the same matrix, is what the radius becomes.
      const basis = Math.abs(feature.normal.x) > 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
      const inPlane = new THREE.Vector3().crossVectors(feature.normal, basis).normalize()
      const onRim = at(feature.center.clone().addScaledVector(inPlane, feature.radius))
      return {
        kind: 'circle',
        center,
        normal,
        radius: onRim.distanceTo(center),
        rim: feature.rim.map(at)
      }
    }
    case 'plane': {
      const origin = at(feature.origin)
      return {
        kind: 'plane',
        planeId: feature.planeId,
        normal: normalAt(feature.normal),
        origin,
        borders: feature.borders.map((loop) => loop.map(at)),
        edges: feature.edges.map(([a, b]) => [at(a), at(b)] as [THREE.Vector3, THREE.Vector3])
      }
    }
  }
}

/**
 * Whether a pick resolved to the CENTRE of the circle it came from, as opposed to the circle itself
 * or a free point somewhere on it.
 *
 * Tested on the position rather than the kinds, because Shift-picking a free point on a hole's rim
 * also produces a point feature over a circle source, and the two must not be drawn or labelled
 * alike -- one is the middle of the hole, the other is wherever the user aimed.
 */
export function isCircleCentrePick(feature: MeasureFeature, source: MeasureFeature): boolean {
  return source.kind === 'circle'
    && feature.kind === 'point'
    && feature.point.distanceToSquared(source.center) < 1e-12
}

/**
 * Whether two features describe the same thing, Studio's `SurfaceFeature::operator==`
 * (`Measure.hpp:76`).
 *
 * Needed because the hover resolves a feature on every pointer MOVE, and rebuilding its highlight
 * each time would churn scene objects at pointer rate for a feature that has not changed. An edge
 * compares either way round, as Studio's does: the same edge reached from two different faces of
 * the same plane can arrive with its ends swapped.
 */
export function sameMeasureFeature(a: MeasureFeature | null, b: MeasureFeature | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'point':
      return a.point.equals((b as typeof a).point)
    case 'edge': {
      const other = b as typeof a
      return (a.start.equals(other.start) && a.end.equals(other.end))
        || (a.start.equals(other.end) && a.end.equals(other.start))
    }
    case 'circle': {
      const other = b as typeof a
      return a.center.equals(other.center) && a.normal.equals(other.normal)
        && Math.abs(a.radius - other.radius) < 1e-4
    }
    case 'plane': {
      const other = b as typeof a
      return a.planeId === other.planeId && a.origin.equals(other.origin) && a.normal.equals(other.normal)
    }
  }
}

/** A short name for a feature, matching Studio's own labels (`GLGizmoMeasure.cpp:39`). */
export function measureFeatureLabel(feature: MeasureFeature, source?: MeasureFeature | null): string {
  if (source && source !== feature && source.kind !== feature.kind) {
    // A point derived FROM something is named after what it came from, which is the only way the
    // user can tell a free point on a face from a vertex.
    switch (source.kind) {
      case 'edge': return 'Point on edge'
      case 'circle': return isCircleCentrePick(feature, source) ? 'Center of circle' : 'Point on circle'
      case 'plane': return 'Point on plane'
      default: break
    }
  }
  switch (feature.kind) {
    case 'point': return 'Vertex'
    case 'edge': return 'Edge'
    case 'circle': return 'Circle'
    case 'plane': return 'Plane'
  }
}
