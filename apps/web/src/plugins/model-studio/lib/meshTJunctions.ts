/**
 * Healing the T-junctions a CSG evaluation leaves behind, so a boolean result can be booleaned
 * again.
 *
 * The defect this exists for: three-bvh-csg subdivides a face where the other solid's edge crosses
 * it, but does not subdivide the NEIGHBOURING face that shares the crossed edge. The surface stays
 * geometrically complete -- a union of two overlapping 10mm cubes comes back at exactly the right
 * volume, 1875 -- while an edge-pairing test sees three unpaired edges per site: the long edge, plus
 * the two sub-edges that between them cover it. Measured on that union: 12 sites, 36 unpaired edges,
 * and the count identical at every quantum from 1e-9 to 1e-2, which is what rules out precision and
 * proves welding can never fix it.
 *
 * That made `isClosedSoup` refuse the tool's own output, so a second boolean over a boolean's result
 * failed with "That operand is not a closed solid" on a mesh nothing was wrong with.
 *
 * **Why repair the mesh instead of relaxing the gate.** The gate is load-bearing here in a way it is
 * not in BambuStudio. Studio hands both operands straight to mcut and reports failure afterwards
 * (`GLGizmoMeshBoolean`); it can, because mcut says when it fails. Ours does not: measured against a
 * lidless box, three-bvh-csg throws nothing and returns silently wrong volumes (a union of 1458
 * where the answer is 1875, an intersection of 42 where it is 125). Dropping the check would trade a
 * clear refusal for wrong geometry nobody is told about, so the check stays exactly as strict and
 * the OUTPUT is made honest instead.
 *
 * **What this does NOT fix, measured rather than assumed.** T-junctions are the whole story only on
 * planar results. On curved intersections the evaluator additionally emits genuine cracks: after
 * healing, a sphere-union-box (r=10, 48x32) still carries about 20 boundary edges over vertices of
 * degree 1, 2 and 3, and a degree-1 vertex is a dangling sliver rather than a hole loop. Loosening
 * the tolerance makes that WORSE rather than better, which is what rules out precision as the cause.
 * So this closes the planar case outright -- which is what the cut and dovetail tools produce -- and
 * takes that curved case from ~692 boundary edges to ~20, but a curved result can still be refused
 * as an operand. Filling what is left would mean inventing geometry, which is the one thing a repair
 * here must never do.
 *
 * The residual is tessellation-dependent and smaller than it first looked: a coarser box-union-sphere
 * comes back with 2. The first measurement here said ~26 because a fan-ordering bug was inflating it
 * (see {@link fan}) -- worth remembering as the general lesson, which is that "the engine is at
 * fault" is the most comfortable conclusion available and therefore the one to re-measure after every
 * fix in this file.
 *
 * **This only ever adds connectivity, never coordinates.** Every split happens at a vertex the mesh
 * already carries, re-emitted from `SoupTopology.positions` bit-for-bit, so the healed sub-edges
 * match their neighbours under the same exact-bit identity the gate uses. Nothing is welded, moved,
 * or rounded -- a repair that invented a coordinate could close a real hole by lying about it.
 *
 * Counterparts: `meshTopology.ts` (the shared analysis) and `meshBooleanCore.ts` (the gate and the
 * evaluation this runs at the end of).
 */
import { analyzeSoupTopology, edgeKeyFor, edgeKeyHigh, edgeKeyLow } from './meshTopology'

/**
 * How far off a segment a vertex may sit and still count as lying on it, relative to the mesh's
 * bounding-box diagonal. Deliberately far tighter than any weld tolerance: a T-vertex produced by
 * the evaluator is on the line to within float error, so this needs to absorb rounding and nothing
 * else. Too generous and a repair starts stitching genuinely separate features together.
 */
const ON_EDGE_TOLERANCE_RATIO = 1e-7

/** A triangle awaiting emission, with the pending splits still owed to each of its three edges. */
interface PendingTriangle {
  a: number
  b: number
  c: number
  /** Vertices lying strictly inside edge a-b, ordered from a to b. Likewise b-c and c-a. */
  ab: number[]
  bc: number[]
  ca: number[]
}

/**
 * Subdivide every edge that another vertex lies on, returning a soup that means the same shape with
 * honest connectivity. Returns the input unchanged when there is nothing to heal, which is the
 * overwhelmingly common case and costs one topology pass.
 *
 * Best-effort by design: an edge whose deficiency is a genuine HOLE has no vertex lying inside it,
 * so nothing is split and the mesh stays open. That is the intended outcome -- this closes the gap
 * between "looks open" and "is open", and must never close a real one.
 */
export function healTriangleSoupTJunctions(soup: Float32Array): Float32Array {
  const topology = analyzeSoupTopology(soup)
  if (topology === null) return soup
  const { ids, positions, span, edgeUses } = topology

  // Only an edge the gate would reject is worth examining. On a healthy mesh this is empty and the
  // whole repair costs nothing beyond the analysis already done.
  const deficient: number[] = []
  for (const [key, uses] of edgeUses) if (uses < 2) deficient.push(key)
  if (deficient.length === 0) return soup

  const splits = collectEdgeSplits(deficient, positions, span)
  if (splits.size === 0) return soup

  const out: number[] = []
  const queue: PendingTriangle[] = []
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t]!, b = ids[t + 1]!, c = ids[t + 2]!
    if (a === b || b === c || a === c) {
      // Degenerate triangles own no edges and are carried through untouched rather than dropped:
      // this repair changes connectivity, and silently shedding geometry is a different change.
      emit(out, positions, a, b, c)
      continue
    }
    queue.push({ a, b, c, ab: orderedSplit(splits, span, a, b), bc: orderedSplit(splits, span, b, c), ca: orderedSplit(splits, span, c, a) })
  }

  while (queue.length > 0) {
    const t = queue.pop()!
    // Split one edge per pass, fanning from the corner OPPOSITE it. That corner is off the split
    // edge's line by construction (the triangle is non-degenerate), so no fan triangle is degenerate
    // and every sub-edge of the split edge survives into the output -- which is the whole point, and
    // is exactly what a fan from an ON-line corner would lose.
    if (t.ab.length > 0) { fan(queue, t.c, t.a, t.b, t.ab, t.ca, t.bc); continue }
    if (t.bc.length > 0) { fan(queue, t.a, t.b, t.c, t.bc, t.ab, t.ca); continue }
    if (t.ca.length > 0) { fan(queue, t.b, t.c, t.a, t.ca, t.bc, t.ab); continue }
    emit(out, positions, t.a, t.b, t.c)
  }
  return new Float32Array(out)
}

/**
 * Replace triangle (`from` -> `to` -> `apex`) with a fan from `apex` across the split edge, keeping
 * the original winding. `fromApex` and `apexTo` carry the splits still owed to the two edges that
 * survive into the fan's end triangles; the interior spokes the fan creates own none.
 */
function fan(
  queue: PendingTriangle[],
  apex: number,
  from: number,
  to: number,
  through: number[],
  fromApexSplits: number[],
  apexToSplits: number[]
): void {
  const chain = [from, ...through, to]
  for (let i = 0; i < chain.length - 1; i++) {
    const p = chain[i]!, q = chain[i + 1]!
    queue.push({
      a: apex,
      b: p,
      c: q,
      // Edge apex-p is the original edge only for the first link; likewise apex-q for the last.
      // Both lists are already ordered along the edge as the new triangle walks it -- `fromApexSplits`
      // runs apex to `from`, which is exactly this triangle's a-to-b -- so neither is reversed. It
      // reads like it should be, and reversing is invisible until an edge carries TWO splits, at
      // which point the fan walks a non-monotonic chain and overlaps itself.
      ab: i === 0 ? fromApexSplits : [],
      bc: [],
      ca: i === chain.length - 2 ? apexToSplits : []
    })
  }
}

/** Append a triangle's three canonical positions to the output soup. */
function emit(out: number[], positions: Float32Array, a: number, b: number, c: number): void {
  for (const id of [a, b, c]) {
    out.push(positions[id * 3]!, positions[id * 3 + 1]!, positions[id * 3 + 2]!)
  }
}

/** The splits owed to directed edge p-q, ordered from p towards q. */
function orderedSplit(splits: Map<number, number[]>, span: number, p: number, q: number): number[] {
  const found = splits.get(edgeKeyFor(span, p, q))
  if (!found) return []
  // Stored low-to-high by vertex id; a directed edge running the other way needs them reversed.
  return p < q ? found : [...found].reverse()
}

/**
 * For each deficient edge, the vertices lying strictly inside it, ordered from its lower-numbered
 * endpoint. Candidates come from a uniform grid over the mesh's vertices, so a long edge tests the
 * handful of vertices near it rather than all of them.
 */
function collectEdgeSplits(deficient: number[], positions: Float32Array, span: number): Map<number, number[]> {
  const count = positions.length / 3
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ)
  if (!(diagonal > 0)) return new Map()
  const tolerance = diagonal * ON_EDGE_TOLERANCE_RATIO

  // A cell per ~cube-root-of-count slice of the diagonal keeps the buckets small without making the
  // walk along a long edge expensive.
  const cell = diagonal / Math.max(4, Math.min(128, Math.cbrt(count) * 2))
  const grid = new Map<string, number[]>()
  const cellKey = (x: number, y: number, z: number) =>
    `${Math.floor((x - minX) / cell)},${Math.floor((y - minY) / cell)},${Math.floor((z - minZ) / cell)}`
  for (let v = 0; v < count; v++) {
    const key = cellKey(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!)
    const bucket = grid.get(key)
    if (bucket) bucket.push(v)
    else grid.set(key, [v])
  }

  const splits = new Map<number, number[]>()
  for (const key of deficient) {
    const p = edgeKeyLow(span, key), q = edgeKeyHigh(span, key)
    const px = positions[p * 3]!, py = positions[p * 3 + 1]!, pz = positions[p * 3 + 2]!
    const ux = positions[q * 3]! - px, uy = positions[q * 3 + 1]! - py, uz = positions[q * 3 + 2]! - pz
    const lengthSquared = ux * ux + uy * uy + uz * uz
    if (lengthSquared === 0) continue

    const found: { id: number; t: number }[] = []
    const seen = new Set<number>()
    // Walk the cells the segment passes through, sampling at half a cell so none is stepped over.
    const steps = Math.ceil(Math.sqrt(lengthSquared) / (cell / 2)) + 1
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const cx = px + ux * t, cy = py + uy * t, cz = pz + uz * t
      const gx = Math.floor((cx - minX) / cell), gy = Math.floor((cy - minY) / cell), gz = Math.floor((cz - minZ) / cell)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = grid.get(`${gx + dx},${gy + dy},${gz + dz}`)
        if (!bucket) continue
        for (const v of bucket) {
          if (v === p || v === q || seen.has(v)) continue
          seen.add(v)
          const wx = positions[v * 3]! - px, wy = positions[v * 3 + 1]! - py, wz = positions[v * 3 + 2]! - pz
          const along = (wx * ux + wy * uy + wz * uz) / lengthSquared
          // Strictly inside: a vertex at either end is the endpoint itself, not a T-vertex.
          if (along <= 0 || along >= 1) continue
          const dxp = wx - ux * along, dyp = wy - uy * along, dzp = wz - uz * along
          if (Math.hypot(dxp, dyp, dzp) > tolerance) continue
          found.push({ id: v, t: along })
        }
      }
    }
    if (found.length === 0) continue
    found.sort((l, r) => l.t - r.t)
    splits.set(key, found.map((entry) => entry.id))
  }
  return splits
}
