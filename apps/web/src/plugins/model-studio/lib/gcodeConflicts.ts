/**
 * Toolpath conflict detection: do two objects' extrusions cross on the same layer? (#92)
 *
 * A port of BambuStudio's `ConflictChecker` (`src/libslic3r/GCode/ConflictChecker.cpp`) onto
 * PARSED G-CODE rather than onto slice-time `ExtrusionPath`s. That re-basing is sound because the
 * check consumes nothing a G-code file lacks: it is a purely 2D centreline test over per-layer
 * polylines grouped by object, and it never looks at line width, layer height, mm3/mm, region
 * config or surface type. What it does need -- XY endpoints, a layer grouping, an owner, and the
 * feature role for one exemption -- our parse already has.
 *
 * Two things the port genuinely cannot reproduce, and one it improves:
 *
 * - **Object NAMES.** Studio reports `ModelObject::name`. Bambu-flavour G-code writes only a
 *   numeric label id (`GCode.cpp:5351-5365`; the name comment is emitted for non-BBL flavours
 *   only), so a caller that wants real names must supply them from the 3MF. Absent those, the
 *   report carries ids and the UI says "an object".
 * - **Which conflict is reported.** Studio parallelises over layers and returns whichever thread
 *   won, so its answer is not deterministic and is not necessarily the lowest layer. Ours reports
 *   the LOWEST conflicting layer, which is what a user would expect and what Studio intends.
 * - Studio offsets every object by `instances().front().shift`, so a second COPY of an object is
 *   checked in the first copy's place. Keying on the per-instance label id, as G-code does, gets
 *   multi-copy plates right where upstream does not.
 *
 * The exclusions matter as much as the test. Studio never sees brim, skirt, wipe, flush or the
 * prime tower's infill, because it reads structures those are not part of; our G-code contains
 * all of them, and brim in particular is emitted INSIDE the object's own label block, so a naive
 * "group by label id" flags every plate whose brims touch. See {@link CONFLICT_EXEMPT_ROLES}.
 */
import { GCODE_FEATURE_ROLES } from './gcodeFeatureRoles'

/**
 * Cell size (mm) of the broad-phase hash grid, matching `RasteXDistance`/`RasteYDistance`
 * (`ConflictChecker.cpp:16-17`). Segments are registered in every cell they touch and only
 * compared against segments already in one of those cells.
 */
const GRID_CELL_MM = 1

/**
 * How far apart two crossing paths must be from their own endpoints to count as a real conflict
 * (Studio's `OTHER_THRESHOLD`, `ConflictChecker.cpp:292`). Paths that merely touch end-to-end
 * within 10um are adjacency, not collision. The same figure is the minimum collinear overlap.
 */
const CONFLICT_TOLERANCE_MM = 0.01

/**
 * Roles excluded from the check.
 *
 * Skirt and Brim because Studio's inputs never contain them and they are DESIGNED to run close to
 * (and between) objects; flush and custom G-code because they are purge, not part geometry.
 *
 * The PRIME TOWER is a divergence rather than an exemption: Studio checks the tower's outer wall
 * against every object, but Bambu emits the tower outside any `; start printing object` block, so
 * its segments carry no owner and are dropped by the `objectId < 0` filter before a role is ever
 * consulted. Listing `primeTower` here would therefore change nothing. Giving the tower a synthetic
 * owner id would restore the check; it is not done because nothing has needed it, not because the
 * tower is believed safe.
 */
const CONFLICT_EXEMPT_ROLES = new Set<number>([
  GCODE_FEATURE_ROLES.skirt,
  GCODE_FEATURE_ROLES.brim,
  GCODE_FEATURE_ROLES.custom,
  GCODE_FEATURE_ROLES.flush
])

/**
 * Roles that are support. Two SUPPORT paths crossing is not reported, because Studio raises its
 * threshold to 100mm for that pair, which no real segment can exceed -- its own comment says this
 * "almost disables conflict check of supports" (`ConflictChecker.cpp:291`). Support against model
 * is still checked normally.
 */
const SUPPORT_ROLES = new Set<number>([GCODE_FEATURE_ROLES.support, GCODE_FEATURE_ROLES.supportInterface])

export interface GcodeToolpathConflict {
  /** 0-based layer index of the LOWEST conflict found. */
  layer: number
  /** The layer's print Z in mm. */
  layerZ: number
  /** The two colliding objects' G-code label ids. */
  objectIds: [number, number]
  /** Where they cross, in bed millimetres. */
  point: { x: number; y: number }
}

interface ConflictSegment {
  ax: number; ay: number; bx: number; by: number
  objectId: number
  role: number
  /**
   * Which candidate last compared against this segment.
   *
   * A pair meets in every cell they share, so without this a long neighbour is re-tested several
   * times. A stamp rather than a `Set` per candidate: this runs once per segment, and 460k Set
   * allocations is the kind of cost that only shows up on a real plate.
   */
  stamp: number
}

/**
 * A cell coordinate pair packed into one integer, so the grid can be keyed by number.
 *
 * A string key allocates per lookup, and this is the innermost loop of the whole check. The bias
 * covers coordinates well beyond any bed (a cell is 1mm), and the multiplier exceeds any plausible
 * span, so distinct cells cannot collide.
 */
function cellKey(cx: number, cy: number): number {
  return (cx + 4096) * 65536 + (cy + 4096)
}

/**
 * Every 1mm cell a segment passes through, appended to `out` as flat (cx, cy) pairs.
 *
 * An Amanatides-Woo voxel walk, the same traversal as Studio's `line_rasterization`
 * (`ConflictChecker.cpp:28-89`). Writes into a caller-owned array rather than returning one,
 * because it is called once per segment.
 */
function cellsForSegment(segment: ConflictSegment, out: number[]): void {
  out.length = 0
  let cx = Math.floor(segment.ax / GRID_CELL_MM)
  let cy = Math.floor(segment.ay / GRID_CELL_MM)
  const endX = Math.floor(segment.bx / GRID_CELL_MM)
  const endY = Math.floor(segment.by / GRID_CELL_MM)
  out.push(cx, cy)
  if (cx === endX && cy === endY) return

  const dx = segment.bx - segment.ax
  const dy = segment.by - segment.ay
  const stepX = dx > 0 ? 1 : -1
  const stepY = dy > 0 ? 1 : -1
  // Distance (in units of the segment's parameter t) to the next cell boundary on each axis, and
  // the t-span of a whole cell on each axis. A zero component never advances, hence the Infinity.
  const tDeltaX = dx !== 0 ? Math.abs(GRID_CELL_MM / dx) : Infinity
  const tDeltaY = dy !== 0 ? Math.abs(GRID_CELL_MM / dy) : Infinity
  const nextBoundaryX = (cx + (stepX > 0 ? 1 : 0)) * GRID_CELL_MM
  const nextBoundaryY = (cy + (stepY > 0 ? 1 : 0)) * GRID_CELL_MM
  let tMaxX = dx !== 0 ? (nextBoundaryX - segment.ax) / dx : Infinity
  let tMaxY = dy !== 0 ? (nextBoundaryY - segment.ay) / dy : Infinity

  // Bounded by the cells the segment could possibly cross, so a degenerate input cannot spin.
  const limit = Math.abs(endX - cx) + Math.abs(endY - cy) + 2
  for (let i = 0; i < limit; i++) {
    if (tMaxX < tMaxY) { cx += stepX; tMaxX += tDeltaX } else { cy += stepY; tMaxY += tDeltaY }
    out.push(cx, cy)
    if (cx === endX && cy === endY) return
  }
}

/** Squared distance between two points. */
function distanceSquared(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx, dy = ay - by
  return dx * dx + dy * dy
}

/**
 * Do these two segments conflict? Ports `ConflictChecker::line_intersect`
 * (`ConflictChecker.cpp:289-314`) including both of its rules and their asymmetric tolerances.
 *
 * Returns the crossing point, or null.
 */
function segmentsConflict(a: ConflictSegment, b: ConflictSegment): { x: number; y: number } | null {
  if (a.objectId === b.objectId) return null
  const bothSupport = SUPPORT_ROLES.has(a.role) && SUPPORT_ROLES.has(b.role)
  if (bothSupport) return null

  const r1x = a.bx - a.ax, r1y = a.by - a.ay
  const r2x = b.bx - b.ax, r2y = b.by - b.ay
  const denominator = r1x * r2y - r1y * r2x

  // Collinear overlap: near-parallel AND on the same line. Studio measures the overlap length and
  // requires more than the tolerance, so two walls that merely graze in passing are not flagged.
  if (Math.abs(denominator) < 1e-9) {
    const cross = r1x * (b.ay - a.ay) - r1y * (b.ax - a.ax)
    const length1 = Math.hypot(r1x, r1y)
    if (length1 < 1e-9 || Math.abs(cross) / length1 > CONFLICT_TOLERANCE_MM) return null
    // Project both onto a's direction and measure how much of the two spans coincide.
    const ux = r1x / length1, uy = r1y / length1
    const project = (px: number, py: number) => (px - a.ax) * ux + (py - a.ay) * uy
    const aStart = 0, aEnd = length1
    let bStart = project(b.ax, b.ay), bEnd = project(b.bx, b.by)
    if (bStart > bEnd) { const swap = bStart; bStart = bEnd; bEnd = swap }
    const overlap = Math.min(aEnd, bEnd) - Math.max(aStart, bStart)
    if (overlap <= CONFLICT_TOLERANCE_MM) return null
    const midpoint = (Math.max(aStart, bStart) + Math.min(aEnd, bEnd)) / 2
    return { x: a.ax + ux * midpoint, y: a.ay + uy * midpoint }
  }

  const t = ((b.ax - a.ax) * r2y - (b.ay - a.ay) * r2x) / denominator
  const u = ((b.ax - a.ax) * r1y - (b.ay - a.ay) * r1x) / denominator
  if (t < 0 || t > 1 || u < 0 || u > 1) return null

  const x = a.ax + r1x * t
  const y = a.ay + r1y * t
  // Studio ignores a crossing that lands within the tolerance of ANY of the four endpoints: paths
  // that meet at their ends are touching, not colliding. Without this every shared corner reports.
  const nearest = Math.sqrt(Math.min(
    Math.min(distanceSquared(x, y, a.ax, a.ay), distanceSquared(x, y, a.bx, a.by)),
    Math.min(distanceSquared(x, y, b.ax, b.ay), distanceSquared(x, y, b.bx, b.by))
  ))
  if (nearest <= CONFLICT_TOLERANCE_MM) return null
  return { x, y }
}

/** The parse fields the scan reads. Deliberately narrow: it needs no width, height or flow. */
export interface GcodeConflictInput {
  layerCount: number
  layerZ: number[]
  extrusionPositions: Float32Array
  extrusionLayerEnd: number[]
  extrusionRoles: Uint8Array
  extrusionObjectIds: Int32Array
}

/**
 * Scan for the lowest layer on which two different objects' toolpaths cross, YIELDING after each
 * layer so a caller can spread the work across frames.
 *
 * The whole scan is about a second on a real 460k-segment plate (median 976ms over 5 runs). Run in
 * one go that is a frozen tab: the layer slider, the move scrubber and orbiting all stall, and a
 * user who starts scrubbing the moment the preview paints loses the gesture. Deferring it with
 * `setTimeout` does not help, because the task itself is uninterruptible; yielding per layer
 * (~3ms of work each) is what actually keeps frames free. {@link findGcodeToolpathConflict}
 * drains it synchronously for tests and for callers with no frame budget to protect.
 *
 * Returns after the first conflicting LAYER, as Studio does within a layer: one report is what the
 * user acts on, and continuing would cost a full scan of a plate already known to be bad.
 * A plate with fewer than two printed objects is answered without any geometry work.
 */
export function* scanGcodeToolpathConflicts(
  parsed: GcodeConflictInput
): Generator<void, GcodeToolpathConflict | null, void> {
  // Studio's own early-out (`ConflictChecker.cpp:226`): nothing can conflict with nothing.
  const distinctObjects = new Set<number>()
  for (let i = 0; i < parsed.extrusionObjectIds.length; i++) {
    const id = parsed.extrusionObjectIds[i]!
    if (id >= 0) distinctObjects.add(id)
    if (distinctObjects.size > 1) break
  }
  if (distinctObjects.size < 2) return null

  const scratch: LayerScanScratch = {
    cells: new Map<number, ConflictSegment[]>(),
    scratchCells: [],
    stamp: 1
  }
  for (let layer = 0; layer < parsed.layerCount; layer++) {
    const found = scanOneLayer(parsed, layer, scratch)
    if (found) return found
    // One layer of work per slice: about 2ms on a real plate, small enough to fit between frames.
    yield
  }
  return null
}

/** Grid state reused across layers, so the scan allocates once rather than per layer. */
interface LayerScanScratch {
  cells: Map<number, ConflictSegment[]>
  scratchCells: number[]
  stamp: number
}

/**
 * Scan ONE layer, returning its first conflict or null.
 *
 * A plain function called BY the generator rather than inline in it, so the slicing concern and
 * the scanning logic stay separable and the grid state carried between layers is explicit.
 *
 * (No generator penalty was demonstrated: an earlier note here claimed inlining cost 630ms ->
 * 1163ms, but both were single runs and repeated measurement put the scan at a steady ~976ms
 * either way. Do not repeat that claim without benchmarking it properly.)
 */
function scanOneLayer(
  parsed: GcodeConflictInput,
  layer: number,
  scratch: LayerScanScratch
): GcodeToolpathConflict | null {
  // Hoisted out of the loop: these are property loads off `parsed` on every one of a layer's
  // segments otherwise.
  const positions = parsed.extrusionPositions
  const objectIds = parsed.extrusionObjectIds
  const roles = parsed.extrusionRoles
  const { cells, scratchCells } = scratch
  const startSeg = (layer > 0 ? parsed.extrusionLayerEnd[layer - 1]! : 0) / 2
  const endSeg = parsed.extrusionLayerEnd[layer]! / 2
  cells.clear()

  for (let seg = startSeg; seg < endSeg; seg++) {
    const objectId = objectIds[seg]!
    if (objectId < 0) continue
    const role = roles[seg]!
    if (CONFLICT_EXEMPT_ROLES.has(role)) continue
    const o = seg * 6
    const candidate: ConflictSegment = {
      ax: positions[o]!, ay: positions[o + 1]!,
      bx: positions[o + 3]!, by: positions[o + 4]!,
      objectId,
      role,
      stamp: 0
    }
    if (candidate.ax === candidate.bx && candidate.ay === candidate.by) continue

    // Register in exactly the cells the segment CROSSES, walked with a DDA, as Studio's
    // `line_rasterization` does. The bounding box is a tempting substitute -- it is a superset,
    // so it can only add candidate pairs, never miss one -- but it is catastrophically bigger
    // for the long diagonal runs that solid infill is made of: measured on a real plate it put
    // 126 cells per segment into the grid and produced 3.6 BILLION candidate pairs (28s), where
    // the DDA gives about 4 per segment. Correct-but-a-superset is not good enough here.
    cellsForSegment(candidate, scratchCells)
    for (let i = 0; i < scratchCells.length; i += 2) {
      const key = cellKey(scratchCells[i]!, scratchCells[i + 1]!)
      let bucket = cells.get(key)
      if (!bucket) { bucket = []; cells.set(key, bucket) }
      for (const other of bucket) {
        // A segment shares several cells with the same neighbour; the stamp makes each pair
        // settle once per candidate without allocating a Set per segment.
        if (other.stamp === scratch.stamp) continue
        other.stamp = scratch.stamp
        const point = segmentsConflict(candidate, other)
        if (point) {
          return {
            layer,
            layerZ: parsed.layerZ[layer] ?? 0,
            objectIds: [candidate.objectId, other.objectId],
            point
          }
        }
      }
      bucket.push(candidate)
    }
    scratch.stamp += 1
  }
  return null
}

/**
 * Run {@link scanGcodeToolpathConflicts} to completion synchronously.
 *
 * For tests and for callers with no frame budget to protect. `PreviewView` drives the generator
 * itself so the scan cannot block the preview it has just opened.
 */
export function findGcodeToolpathConflict(parsed: GcodeConflictInput): GcodeToolpathConflict | null {
  const scan = scanGcodeToolpathConflicts(parsed)
  let step = scan.next()
  while (!step.done) step = scan.next()
  return step.value
}
