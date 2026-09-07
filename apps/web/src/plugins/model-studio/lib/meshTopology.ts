/**
 * The connectivity a triangle soup implies: canonical vertex identity, facet multiplicity, and the
 * undirected edge-use counts everything else is decided from.
 *
 * Extracted from `isClosedSoup` so that the question ("does this bound a volume?") and the repair
 * that answers it ("heal the T-junctions that make it look otherwise") read the SAME numbers. They
 * were about to be two implementations of one analysis, which is how a mesh gets flagged by one rule
 * and left untouched by the other.
 *
 * Owns two decisions that callers must not re-make:
 *
 *  - **Vertex identity is BIT-EXACT**, with no tolerance and no rounding. That is a correctness
 *    property, not a shortcut: viewport geometry arrives already welded (`meshParseCore` runs
 *    `mergeVertices` then `toCreasedNormals`, which de-indexes by COPYING each merged vertex into
 *    every corner using it), so shared corners hold identical floats and exact keys recover the
 *    original connectivity. Welding here instead would be a repair posing as an oracle.
 *  - **Cover multiplicity is divided out**, so a mesh whose every facet is written twice is counted
 *    as the shell it is rather than passing a "no edge used once" test on a wide-open surface.
 *
 * Counterparts: `meshBooleanCore.ts` (the closed-solid gate) and `meshTJunctions.ts` (the repair).
 */

/** Undirected edge keys pack a vertex pair into one number, so `span` is needed to read them back. */
export interface SoupTopology {
  /** Canonical vertex id per soup corner, three per triangle. */
  ids: Int32Array
  /**
   * One canonical position per id, three floats each. Negative zero is folded onto zero (IEEE 754
   * gives it a second encoding that a transform can produce either way); nothing else is normalized,
   * so these are the soup's own coordinates and are safe to re-emit verbatim.
   */
  positions: Float32Array
  /** Canonical vertex count, and the stride an edge key is packed against. */
  span: number
  /** The smallest number of times any facet appears: 1 for an ordinary mesh, 2 for a doubled one. */
  cover: number
  /** Undirected edge key to uses, with `cover` already divided out. */
  edgeUses: Map<number, number>
}

/** Pack an unordered vertex pair into the key `edgeUses` is indexed by. */
export function edgeKeyFor(span: number, p: number, q: number): number {
  return p < q ? p * span + q : q * span + p
}

/** The lower-numbered endpoint of a key from {@link edgeKeyFor}. */
export function edgeKeyLow(span: number, key: number): number {
  return Math.floor(key / span)
}

/** The higher-numbered endpoint of a key from {@link edgeKeyFor}. */
export function edgeKeyHigh(span: number, key: number): number {
  return key % span
}

/**
 * Analyse a soup's connectivity, or `null` when there is nothing to analyse: an empty soup, a length
 * that is not whole triangles, or geometry whose every triangle is degenerate. A caller deciding
 * closedness must treat `null` as "not closed" rather than as "no boundary found".
 *
 * Costs one pass over the corners plus one over the distinct facets (measured ~0.4s on a
 * 663k-triangle model). Keys are NUMERIC throughout because string keys were the whole cost at that
 * size: 3.1s against 0.4s for the identical answer.
 */
export function analyzeSoupTopology(soup: Float32Array): SoupTopology | null {
  if (soup.length === 0 || soup.length % 9 !== 0) return null
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length)

  // Vertex identity by exact bit pattern, hashed into buckets whose scan still compares the raw
  // bits, so identity stays exact while the cost stays numeric.
  const buckets = new Map<number, number[]>()
  const ids = new Int32Array(soup.length / 3)
  const canonicalBits: number[] = []
  for (let v = 0; v < ids.length; v++) {
    const b = v * 3
    const x = bits[b]!, y = bits[b + 1]!, z = bits[b + 2]!
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

  // Facets are keyed off those ids the same way: a corner pair packs into one double and the third
  // corner resolves in a bucket.
  const facetIds = new Map<number, number[]>()
  const facetCorners: number[] = []
  const facetUses: number[] = []
  const span = canonicalBits.length / 3
  for (let t = 0; t < ids.length; t += 3) {
    const a = ids[t]!, b = ids[t + 1]!, c = ids[t + 2]!
    // A degenerate triangle has no surface, so it bounds nothing and owns no edges. The 663k model
    // measured against this carries 228 of them.
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
  if (facetUses.length === 0) return null

  // Dividing by the cover rather than collapsing every facet to one copy is load-bearing, and a real
  // model forced it. A coincident PAIR of triangles is a zero-thickness flap whose free rim is used
  // exactly twice, by its own two copies, which is indistinguishable edge-for-edge from a doubled
  // shell's boundary; only the scale tells them apart. That model has two such flaps and is
  // watertight, so flattening to one copy would open its rims and refuse a mesh that slices
  // perfectly, while dividing leaves them at two and preserves the answer at any cover.
  let cover = Infinity
  for (const uses of facetUses) if (uses < cover) cover = uses
  const edgeUses = new Map<number, number>()
  for (let facet = 0; facet < facetUses.length; facet++) {
    const weight = Math.floor(facetUses[facet]! / cover)
    const lo = facetCorners[facet * 3]!, mid = facetCorners[facet * 3 + 1]!, hi = facetCorners[facet * 3 + 2]!
    for (const key of [edgeKeyFor(span, lo, mid), edgeKeyFor(span, mid, hi), edgeKeyFor(span, lo, hi)]) {
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + weight)
    }
  }
  if (edgeUses.size === 0) return null

  const positions = new Float32Array(canonicalBits.length)
  const positionBits = new Uint32Array(positions.buffer)
  for (let i = 0; i < canonicalBits.length; i++) positionBits[i] = canonicalBits[i]!
  return { ids, positions, span, cover, edgeUses }
}
