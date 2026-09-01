/**
 * The CSG evaluation itself, with no DOM and no React: importable from a Web Worker.
 *
 * Split from `meshBoolean.ts` (which owns the RULES: validation, the operand lists, the consumption
 * plan) so the same evaluation can run in `meshBooleanWorker.ts` and, when that mechanism is
 * unavailable, on the main thread. Nothing here touches `window`, `document` or a three.js renderer
 * -- it builds geometry, evaluates, and hands back a plain triangle soup.
 *
 * The closed-solid gate lives HERE rather than with the rules, and runs inside the evaluation
 * itself, because it is the same cost class as the boolean (about a second on a 663k-triangle
 * operand) and so belongs on whichever thread is doing the work. That is also why its refusal
 * carries an operand INDEX: the worker knows which operand failed, and only the caller knows what
 * the user calls it.
 *
 * Counterparts: `meshBooleanWorker.ts` (the wire contract) and `meshBooleanClient.ts` (the pool of
 * one, the deadline, and the fallback that keeps a worker-less environment working).
 */
import * as THREE from 'three'
import type { Brush as BrushType } from 'three-bvh-csg'
import type { MeshBooleanOperation } from './meshBoolean'

/**
 * The CSG engine, fetched on FIRST USE rather than with the editor.
 *
 * It is only needed by someone who runs a boolean, so a static import would put it in the editor's
 * chunk for everyone who opens a project. Cached because the second boolean should not wait on the
 * network, and awaited as a promise so two quick operations share one fetch.
 */
let enginePromise: Promise<typeof import('three-bvh-csg')> | null = null
function loadCsgEngine(): Promise<typeof import('three-bvh-csg')> {
  enginePromise ??= import('three-bvh-csg')
  return enginePromise
}

/** A soup as geometry the evaluator can take. */
function brushFor(engine: typeof import('three-bvh-csg'), soup: Float32Array): BrushType {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(soup.slice(), 3))
  geometry.computeVertexNormals()
  const brush = new engine.Brush(geometry)
  brush.updateMatrixWorld()
  return brush
}

/** Read a brush's evaluated geometry back out as a plain soup. */
function soupFrom(brush: BrushType): Float32Array {
  const geometry = brush.geometry
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry
  const position = nonIndexed.getAttribute('position')
  const soup = new Float32Array(position.array.length)
  soup.set(position.array as Float32Array)
  if (nonIndexed !== geometry) nonIndexed.dispose()
  return soup
}

/**
 * Evaluate one operation over two groups of WORLD-space soups.
 *
 * `listB` is used by `difference` only, where the result is (everything in A) minus (everything in
 * B); union and intersection fold `listA` alone. Folding rather than a single n-ary call because the
 * evaluator is binary, and folding intersection is the only way to express "the volume common to all
 * of them" without special-casing the count.
 *
 * Returns an empty soup when the operation leaves nothing behind, which is a real answer -- two
 * shapes that do not touch have no intersection -- and which the caller must not treat as failure
 * without saying so.
 */
export async function evaluateMeshBooleanSoups(
  operation: MeshBooleanOperation,
  listA: Float32Array[],
  listB: Float32Array[] = []
): Promise<Float32Array> {
  // THE gate, run here rather than at the call site so it lands on whichever thread is doing the
  // work: it costs about a second on a 663k-triangle operand, which is precisely the main-thread
  // freeze the worker exists to avoid.
  const open = findOpenOperand(listA, listB)
  if (open !== null) throw new MeshBooleanOpenOperandError(open)
  const engine = await loadCsgEngine()
  const csgOperation = {
    union: engine.ADDITION,
    difference: engine.SUBTRACTION,
    intersection: engine.INTERSECTION
  } as const
  const evaluator = new engine.Evaluator()
  // One material for the result: the operands' groups mean nothing once the solids are merged.
  evaluator.useGroups = false
  // ONLY what our soups carry. The evaluator's default list includes `uv`, and it dereferences each
  // named attribute unconditionally, so leaving the default in place throws on printable geometry --
  // which never has texture coordinates -- rather than simply ignoring the missing one.
  evaluator.attributes = ['position', 'normal']

  const fold = (soups: Float32Array[], op: MeshBooleanOperation): BrushType | null => {
    if (soups.length === 0) return null
    let accumulated = brushFor(engine, soups[0]!)
    for (let i = 1; i < soups.length; i++) {
      const next = brushFor(engine, soups[i]!)
      accumulated = evaluator.evaluate(accumulated, next, csgOperation[op])
    }
    return accumulated
  }

  if (operation === 'difference') {
    // Each side is unioned first, so "A minus B" means the whole of A minus the whole of B rather
    // than a chain whose answer would depend on the order the user happened to add things.
    const a = fold(listA, 'union')
    const b = fold(listB, 'union')
    if (!a) return new Float32Array(0)
    if (!b) return soupFrom(a)
    return soupFrom(evaluator.evaluate(a, b, engine.SUBTRACTION))
  }
  const folded = fold(listA, operation)
  return folded ? soupFrom(folded) : new Float32Array(0)
}

/**
 * Re-express a WORLD-space soup in an object's own frame, in place on a copy.
 *
 * The part-mode result arrives in world space (that is what `collectWorldTriangles` produces) but an
 * added part's soup is read RELATIVE to its host: the mesh hangs on the rotor, whose local space is
 * 3MF object space, so the triangles have to be pulled back through the rotor's inverse and the
 * part left at an identity placement. Getting this wrong does not throw -- it puts the new volume
 * somewhere plausible and wrong, which on a rotated or scaled host is nowhere near the geometry it
 * was cut from.
 *
 * Takes the INVERSE matrix rather than the rotor so this stays free of the scene graph and can be
 * checked against a known transform.
 */
export function toObjectLocalSoup(soup: Float32Array, worldToObject: THREE.Matrix4): Float32Array {
  const local = soup.slice()
  const vertex = new THREE.Vector3()
  for (let i = 0; i < local.length; i += 3) {
    vertex.set(local[i]!, local[i + 1]!, local[i + 2]!).applyMatrix4(worldToObject)
    local[i] = vertex.x
    local[i + 1] = vertex.y
    local[i + 2] = vertex.z
  }
  return local
}

/**
 * Whether a soup encloses a volume: the gate that keeps a boolean honest.
 *
 * CSG asks "is this point inside?", which has no answer for a surface with a boundary, and it does
 * not fail on one -- it returns plausible geometry that slices into nonsense. So an operand with a
 * hole is refused before it can be combined.
 *
 * Vertex identity is BIT-EXACT, with no tolerance and no rounding, and that is a correctness
 * property rather than a shortcut. Viewport geometry reaches here already welded: `meshParseCore`
 * runs `mergeVertices` and then `toCreasedNormals`, which de-indexes by COPYING each merged vertex
 * to every corner that uses it, so shared corners hold identical floats and exact keys recover the
 * original connectivity exactly. `applyMatrix4` is deterministic, so that survives the world
 * transform too (measured on a 663k-triangle model: 994,844 edges, zero boundary, in local and world
 * space alike, and identical to what a 0.1-micron grid reports).
 *
 * What must NOT be done here, both tried and both wrong:
 *
 *  - **Do not weld.** `repairImportedMeshGeometry` merges at a tolerance scaled to the model's
 *    diagonal (0.063mm on that model), which is coarser than a dense mesh's real features: it merged
 *    599 vertices, dropped the 1,198 triangles that collapsed, and left 10 holes in a mesh that was
 *    watertight. A repair is a repair, not an oracle.
 *  - **Do not reject over-shared edges.** That same model has 220 edges used by more than two
 *    triangles, as does any pair of solids meeting along an edge. Non-manifold is not open, and it
 *    is only openness that CSG cannot answer.
 *
 * Duplicate facets are COLLAPSED rather than rejected, because a real model can carry a few (17 in
 * that same mesh) and still be perfectly closed. Collapsing is what catches the export that writes
 * every facet twice: doubling puts every edge at four uses, which passes a "no edge used once" rule
 * on a shell that is wide open.
 */
export function isClosedSoup(soup: Float32Array): boolean {
  if (soup.length === 0 || soup.length % 9 !== 0) return false
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length)

  // Vertex identity by exact bit pattern. A numeric hash into buckets, rather than a string key per
  // corner: the strings are the whole cost at this size (measured 3.1s on 663k triangles, against
  // ~0.4s here), and the bucket scan still compares the raw bits, so identity stays exact.
  const buckets = new Map<number, number[]>()
  const ids = new Int32Array(soup.length / 3)
  const canonicalBits: number[] = []
  for (let v = 0; v < ids.length; v++) {
    const b = v * 3
    const x = bits[b]!, y = bits[b + 1]!, z = bits[b + 2]!
    // Zero has two encodings in IEEE 754 and a transform can produce either, so -0 is folded onto 0
    // here; nothing else is normalized.
    const hx = x === 0x8000_0000 ? 0 : x
    const hy = y === 0x8000_0000 ? 0 : y
    const hz = z === 0x8000_0000 ? 0 : z
    const hash = (Math.imul(hx, 0x9e37_79b1) ^ Math.imul(hy, 0x85eb_ca6b) ^ Math.imul(hz, 0xc2b2_ae35)) | 0
    let bucket = buckets.get(hash)
    if (!bucket) { bucket = []; buckets.set(hash, bucket) }
    let id = -1
    for (const candidate of bucket) {
      const c = candidate * 3
      if (canonicalBits[c] === hx && canonicalBits[c + 1] === hy && canonicalBits[c + 2] === hz) { id = candidate; break }
    }
    if (id < 0) {
      id = canonicalBits.length / 3
      canonicalBits.push(hx, hy, hz)
      bucket.push(id)
    }
    ids[v] = id
  }

  // Facets are keyed NUMERICALLY off those ids (a corner pair packs into one double, the third
  // corner resolves in a bucket), because at this size string keys were the whole cost of the
  // check: 3.1s against 0.4s on the model measured below.
  const facetIds = new Map<number, number[]>()
  const facetCorners: number[] = []
  const facetUses: number[] = []
  const span = canonicalBits.length / 3
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t]!, b = ids[t + 1]!, c = ids[t + 2]!
    // A degenerate triangle has no surface, so it bounds nothing and owns no edges. The real model
    // measured below carries 228 of them.
    if (a === b || b === c || a === c) continue
    const lo = Math.min(a, b, c), hi = Math.max(a, b, c), mid = a + b + c - lo - hi
    let facet = -1
    const bucket = facetIds.get(lo * span + mid)
    if (bucket) for (const candidate of bucket) if (facetCorners[candidate * 3 + 2] === hi) { facet = candidate; break }
    if (facet < 0) {
      facet = facetUses.length
      facetCorners.push(lo, mid, hi)
      facetUses.push(0)
      if (bucket) bucket.push(facet)
      else facetIds.set(lo * span + mid, [facet])
    }
    facetUses[facet]!++
  }
  if (facetUses.length === 0) return false

  // Edges are counted with the mesh's COVER MULTIPLICITY divided out: the smallest number of times
  // any facet appears. That single number is what catches an export written twice over -- doubling
  // puts every edge at four uses, so a wide-open shell sails through a "no edge used once" rule --
  // and a mesh covered once (the overwhelmingly common case) divides by one and is counted exactly
  // as it is.
  //
  // Dividing rather than collapsing to one copy is load-bearing, and a real model forced it. A
  // coincident PAIR of triangles is a zero-thickness flap whose free rim is used exactly twice, by
  // its own two copies, which is indistinguishable edge-for-edge from a doubled shell's boundary;
  // only the scale tells them apart. The 663k-triangle model measured here has two such flaps and is
  // watertight, so flattening every facet to one copy would open its rims and refuse a model that
  // slices perfectly, while dividing leaves them at two and preserves the answer at any cover.
  let cover = Infinity
  for (const uses of facetUses) if (uses < cover) cover = uses
  const edges = new Map<number, number>()
  const edgeKey = (p: number, q: number) => (p < q ? p * span + q : q * span + p)
  for (let facet = 0; facet < facetUses.length; facet++) {
    const weight = Math.floor(facetUses[facet]! / cover)
    const lo = facetCorners[facet * 3]!, mid = facetCorners[facet * 3 + 1]!, hi = facetCorners[facet * 3 + 2]!
    for (const key of [edgeKey(lo, mid), edgeKey(mid, hi), edgeKey(lo, hi)]) {
      edges.set(key, (edges.get(key) ?? 0) + weight)
    }
  }
  if (edges.size === 0) return false
  // A BOUNDARY edge (used once) is the failure. Over-sharing is not: two solids meeting along an
  // edge are non-manifold yet still bound a volume, which is all CSG needs. The measured model has
  // 220 such edges and slices perfectly.
  for (const count of edges.values()) if (count < 2) return false
  return true
}

/** The first operand that is not a closed solid, as an index into `[...listA, ...listB]`, or null. */
function findOpenOperand(listA: Float32Array[], listB: Float32Array[]): number | null {
  const all = [...listA, ...listB]
  for (let i = 0; i < all.length; i++) if (!isClosedSoup(all[i]!)) return i
  return null
}

/**
 * The GEOMETRY defeated the evaluator, as opposed to the mechanism failing. Surfaced to the user and
 * never retried: the worker and the main-thread fallback run the same code, so a retry buys the
 * identical message at the price of a frozen tab.
 */
export class MeshBooleanDataError extends Error {}

/**
 * An operand has a boundary, so it cannot be booleaned. Carries only the INDEX into the operands as
 * the evaluator received them (`listA` then `listB`) -- naming it is the caller's job, since only
 * the caller knows what the user called that object.
 */
export class MeshBooleanOpenOperandError extends MeshBooleanDataError {
  constructor(readonly operandIndex: number) {
    super('That operand is not a closed solid.')
  }
}
