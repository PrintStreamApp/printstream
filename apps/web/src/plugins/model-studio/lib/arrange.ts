/**
 * Auto-arrange: greedy centre-out packing of object footprints on the plate grid.
 *
 * Pure module (no Three.js) so the packing is unit-testable. Footprints arrive as
 * rasterized grid-cell keys (the same 2mm grid and key packing the editor's
 * placement-warning rasterizer uses — see `footprintCellKey`); the result is a
 * per-item XY translation in mm. Largest items place first, each at the free spot
 * closest to the plate centre, with a configurable clearance ring kept between
 * items (but not against the plate edge), mirroring Bambu Studio's defaults.
 */

/** Collision/packing grid resolution (mm). Matches the editor's warning rasterizer. */
export const FOOTPRINT_CELL_MM = 2

/** Pack grid cell coords into one integer key (supports +/- ~16k cells). */
export function footprintCellKey(cx: number, cy: number): number {
  return (cx + 16384) * 32768 + (cy + 16384)
}

/** Inverse of {@link footprintCellKey}. */
export function decodeFootprintCellKey(key: number): [number, number] {
  return [Math.floor(key / 32768) - 16384, (key % 32768) - 16384]
}

export interface ArrangeItemInput {
  key: string
  /** Footprint cell keys at the item's CURRENT position. */
  cells: ReadonlyArray<number>
}

export interface ArrangeOptions {
  /** Plate rectangle in mm (bed-local coords, same space the cells were built in). */
  bed: { minX: number; maxX: number; minY: number; maxY: number }
  /** Cell keys that must stay empty (exclude zones, prime tower). */
  blockedCells?: ReadonlySet<number>
  /** Minimum clearance kept between items (mm). Bambu's default object gap. */
  spacingMm?: number
}

export interface ArrangeResult {
  /** XY translation (mm) per item key. Items that could not fit are absent. */
  moves: Map<string, { dx: number; dy: number }>
  /** Keys that did not fit anywhere on the plate (left where they were). */
  unplaced: string[]
}

/**
 * Pack the items onto the plate. Returns mm translations relative to each item's
 * current position; callers apply them and re-rest objects on the bed unchanged.
 *
 * Every item's CURRENT footprint stays stamped in the occupancy grid until that
 * item is actually moved (and is re-stamped if it cannot fit), so placements
 * never land on top of an item that ends up staying put — a partial arrange
 * leaves no overlaps, only unplaced items.
 */
export function arrangePlateItems(items: ReadonlyArray<ArrangeItemInput>, options: ArrangeOptions): ArrangeResult {
  const spacing = options.spacingMm ?? 5
  const minCX = Math.floor(options.bed.minX / FOOTPRINT_CELL_MM)
  const maxCX = Math.ceil(options.bed.maxX / FOOTPRINT_CELL_MM) - 1
  const minCY = Math.floor(options.bed.minY / FOOTPRINT_CELL_MM)
  const maxCY = Math.ceil(options.bed.maxY / FOOTPRINT_CELL_MM) - 1
  const width = maxCX - minCX + 1
  const height = maxCY - minCY + 1
  if (width <= 0 || height <= 0) return { moves: new Map(), unplaced: items.map((item) => item.key) }

  // Occupancy grid over the plate (stamp COUNTS, so overlapping clearance rings
  // can be removed independently); out-of-grid is implicitly blocked.
  const occupied = new Uint16Array(width * height)
  const gridIndex = (cx: number, cy: number): number => (cy - minCY) * width + (cx - minCX)
  const inGrid = (cx: number, cy: number): boolean => cx >= minCX && cx <= maxCX && cy >= minCY && cy <= maxCY
  for (const key of options.blockedCells ?? []) {
    const [cx, cy] = decodeFootprintCellKey(key)
    if (inGrid(cx, cy)) {
      const index = gridIndex(cx, cy)
      occupied[index] = (occupied[index] ?? 0) + 1
    }
  }

  const spacingCells = Math.max(1, Math.ceil(spacing / FOOTPRINT_CELL_MM))
  /** Stamp (+1) or unstamp (-1) a footprint dilated by the clearance ring. */
  const stampFootprint = (cells: ReadonlyArray<[number, number]>, dx: number, dy: number, delta: 1 | -1): void => {
    for (const [cx, cy] of cells) {
      for (let ox = -spacingCells; ox <= spacingCells; ox += 1) {
        for (let oy = -spacingCells; oy <= spacingCells; oy += 1) {
          const nx = cx + dx + ox
          const ny = cy + dy + oy
          if (inGrid(nx, ny)) {
            const index = gridIndex(nx, ny)
            occupied[index] = (occupied[index] ?? 0) + delta
          }
        }
      }
    }
  }

  // Items normalized to their bounding-box min corner, biggest first.
  const prepared = items
    .map((item) => {
      const cells = item.cells.map(decodeFootprintCellKey)
      let lo = Infinity, hi = -Infinity, loY = Infinity, hiY = -Infinity
      for (const [cx, cy] of cells) {
        lo = Math.min(lo, cx); hi = Math.max(hi, cx)
        loY = Math.min(loY, cy); hiY = Math.max(hiY, cy)
      }
      return { key: item.key, cells, minCX: lo, maxCX: hi, minCY: loY, maxCY: hiY }
    })
    .filter((item) => item.cells.length > 0)
    .sort((a, b) => b.cells.length - a.cells.length)

  // Stamp every item where it currently stands: items are only unstamped when
  // it is their turn to move, so nothing is placed over an item that may stay.
  for (const item of prepared) stampFootprint(item.cells, 0, 0, 1)

  // Candidate anchor positions for an item's bounding-box CENTRE, nearest the plate
  // centre first — Bambu packs centre-out so plates fill from the middle.
  const centerCX = (minCX + maxCX) / 2
  const centerCY = (minCY + maxCY) / 2
  const candidates: Array<[number, number]> = []
  for (let cy = minCY; cy <= maxCY; cy += 1) {
    for (let cx = minCX; cx <= maxCX; cx += 1) candidates.push([cx, cy])
  }
  candidates.sort((a, b) => {
    const da = (a[0] - centerCX) ** 2 + (a[1] - centerCY) ** 2
    const db = (b[0] - centerCX) ** 2 + (b[1] - centerCY) ** 2
    return da - db
  })

  const moves = new Map<string, { dx: number; dy: number }>()
  const unplaced: string[] = []

  for (const item of prepared) {
    // Lift the item off the grid while we look for its spot (it vacates its
    // current position, so that space is fair game for itself and later items).
    stampFootprint(item.cells, 0, 0, -1)
    const itemCenterCX = (item.minCX + item.maxCX) / 2
    const itemCenterCY = (item.minCY + item.maxCY) / 2
    const halfW = Math.ceil((item.maxCX - item.minCX) / 2)
    const halfH = Math.ceil((item.maxCY - item.minCY) / 2)
    let placed = false
    for (const [tx, ty] of candidates) {
      // Quick reject: the bounding box must fit inside the plate at this anchor.
      if (tx - halfW < minCX || tx + halfW > maxCX || ty - halfH < minCY || ty + halfH > maxCY) continue
      const dx = Math.round(tx - itemCenterCX)
      const dy = Math.round(ty - itemCenterCY)
      let fits = true
      for (const [cx, cy] of item.cells) {
        const nx = cx + dx
        const ny = cy + dy
        if (!inGrid(nx, ny) || occupied[gridIndex(nx, ny)]) { fits = false; break }
      }
      if (!fits) continue
      // Stamp the placed footprint dilated by the clearance ring so the NEXT item
      // keeps its distance; the plate edge gets no ring (objects may touch the rim).
      stampFootprint(item.cells, dx, dy, 1)
      moves.set(item.key, { dx: dx * FOOTPRINT_CELL_MM, dy: dy * FOOTPRINT_CELL_MM })
      placed = true
      break
    }
    if (!placed) {
      // It stays where it is — put its footprint back so later items avoid it.
      stampFootprint(item.cells, 0, 0, 1)
      unplaced.push(item.key)
    }
  }

  return { moves, unplaced }
}
