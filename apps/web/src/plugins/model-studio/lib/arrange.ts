/**
 * Plate packing: greedy centre-out placement of object footprints on the plate grid.
 *
 * Pure module (no Three.js) so the packing is unit-testable. Footprints arrive as
 * rasterized grid-cell keys (the same 2mm grid and key packing the editor's
 * placement-warning rasterizer uses: see `footprintCellKey`); results are XY
 * translations in mm. Two callers, one occupancy model:
 * - {@link arrangePlateItems} (Auto-arrange) moves every item. Largest first, each to the free
 *   spot closest to the plate centre.
 * - {@link planFillBedCopies} (Fill bed with copies) moves nothing and instead places as many
 *   congruent copies of ONE footprint as still fit around what is already there.
 *
 * Both keep a configurable clearance ring between items (but not against the plate edge),
 * mirroring Bambu Studio's defaults.
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

/**
 * Translate a footprint cell set by a whole number of grid cells. A pure move keeps an object's
 * footprint SHAPE, so the placement-warning recompute can shift the cached cells (O(cells)) instead
 * of re-rasterizing every triangle (O(triangles)): the difference between a smooth and a frozen
 * drop for a high-poly / many-part object. The shift rounds to the 2mm grid, which is the
 * collision resolution anyway, so no accuracy is lost.
 */
export function shiftFootprintCells(cells: Set<number>, dCellX: number, dCellY: number): Set<number> {
  if (dCellX === 0 && dCellY === 0) return cells
  const shifted = new Set<number>()
  for (const key of cells) {
    const [cx, cy] = decodeFootprintCellKey(key)
    shifted.add(footprintCellKey(cx + dCellX, cy + dCellY))
  }
  return shifted
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

/** A footprint's grid-cell bounding box, used to anchor it by its centre. */
function cellBounds(cells: ReadonlyArray<[number, number]>): { minCX: number; maxCX: number; minCY: number; maxCY: number } {
  let minCX = Infinity, maxCX = -Infinity, minCY = Infinity, maxCY = -Infinity
  for (const [cx, cy] of cells) {
    minCX = Math.min(minCX, cx); maxCX = Math.max(maxCX, cx)
    minCY = Math.min(minCY, cy); maxCY = Math.max(maxCY, cy)
  }
  return { minCX, maxCX, minCY, maxCY }
}

/**
 * The plate's occupancy raster, shared by both packers so they cannot disagree about what
 * "occupied" means. Cells hold stamp COUNTS rather than flags, so overlapping clearance rings
 * are removed independently and a footprint can be lifted off without erasing a neighbour's ring.
 * Out-of-grid is implicitly blocked.
 */
function createOccupancyGrid(options: ArrangeOptions) {
  const minCX = Math.floor(options.bed.minX / FOOTPRINT_CELL_MM)
  const maxCX = Math.ceil(options.bed.maxX / FOOTPRINT_CELL_MM) - 1
  const minCY = Math.floor(options.bed.minY / FOOTPRINT_CELL_MM)
  const maxCY = Math.ceil(options.bed.maxY / FOOTPRINT_CELL_MM) - 1
  const width = maxCX - minCX + 1
  const height = maxCY - minCY + 1
  if (width <= 0 || height <= 0) return null

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

  const spacingCells = Math.max(1, Math.ceil((options.spacingMm ?? 5) / FOOTPRINT_CELL_MM))

  /** Stamp (+1) or unstamp (-1) a footprint dilated by the clearance ring. */
  const stamp = (cells: ReadonlyArray<[number, number]>, dx: number, dy: number, delta: 1 | -1): void => {
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

  /** Does the footprint, shifted by (dx, dy) cells, land entirely on free in-grid cells? */
  const fits = (cells: ReadonlyArray<[number, number]>, dx: number, dy: number): boolean => {
    for (const [cx, cy] of cells) {
      const nx = cx + dx
      const ny = cy + dy
      if (!inGrid(nx, ny) || occupied[gridIndex(nx, ny)]) return false
    }
    return true
  }

  /**
   * Every in-grid cell as a candidate anchor for a footprint's bounding-box CENTRE, nearest the
   * plate centre first: Bambu packs centre-out so plates fill from the middle.
   */
  const candidatesFromCentre = (): Array<[number, number]> => {
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
    return candidates
  }

  return { minCX, maxCX, minCY, maxCY, stamp, fits, candidatesFromCentre }
}

/**
 * Pack the items onto the plate. Returns mm translations relative to each item's
 * current position; callers apply them and re-rest objects on the bed unchanged.
 *
 * Every item's CURRENT footprint stays stamped in the occupancy grid until that
 * item is actually moved (and is re-stamped if it cannot fit), so placements
 * never land on top of an item that ends up staying put, a partial arrange
 * leaves no overlaps, only unplaced items.
 */
export function arrangePlateItems(items: ReadonlyArray<ArrangeItemInput>, options: ArrangeOptions): ArrangeResult {
  const grid = createOccupancyGrid(options)
  if (!grid) return { moves: new Map(), unplaced: items.map((item) => item.key) }

  // Items normalized to their bounding-box min corner, biggest first.
  const prepared = items
    .map((item) => {
      const cells = item.cells.map(decodeFootprintCellKey)
      return { key: item.key, cells, ...cellBounds(cells) }
    })
    .filter((item) => item.cells.length > 0)
    .sort((a, b) => b.cells.length - a.cells.length)

  // Stamp every item where it currently stands: items are only unstamped when
  // it is their turn to move, so nothing is placed over an item that may stay.
  for (const item of prepared) grid.stamp(item.cells, 0, 0, 1)

  const candidates = grid.candidatesFromCentre()
  const moves = new Map<string, { dx: number; dy: number }>()
  const unplaced: string[] = []

  for (const item of prepared) {
    // Lift the item off the grid while we look for its spot (it vacates its
    // current position, so that space is fair game for itself and later items).
    grid.stamp(item.cells, 0, 0, -1)
    const itemCenterCX = (item.minCX + item.maxCX) / 2
    const itemCenterCY = (item.minCY + item.maxCY) / 2
    const halfW = Math.ceil((item.maxCX - item.minCX) / 2)
    const halfH = Math.ceil((item.maxCY - item.minCY) / 2)
    let placed = false
    for (const [tx, ty] of candidates) {
      // Quick reject: the bounding box must fit inside the plate at this anchor.
      if (tx - halfW < grid.minCX || tx + halfW > grid.maxCX || ty - halfH < grid.minCY || ty + halfH > grid.maxCY) continue
      const dx = Math.round(tx - itemCenterCX)
      const dy = Math.round(ty - itemCenterCY)
      if (!grid.fits(item.cells, dx, dy)) continue
      // Stamp the placed footprint dilated by the clearance ring so the NEXT item
      // keeps its distance; the plate edge gets no ring (objects may touch the rim).
      grid.stamp(item.cells, dx, dy, 1)
      moves.set(item.key, { dx: dx * FOOTPRINT_CELL_MM, dy: dy * FOOTPRINT_CELL_MM })
      placed = true
      break
    }
    if (!placed) {
      // It stays where it is: put its footprint back so later items avoid it.
      grid.stamp(item.cells, 0, 0, 1)
      unplaced.push(item.key)
    }
  }

  return { moves, unplaced }
}

/** Runaway guard for {@link planFillBedCopies}; the plate normally runs out long before this. */
export const MAX_FILL_BED_COPIES = 1000

export interface FillBedOptions extends ArrangeOptions {
  /**
   * The footprint to replicate, at the template instance's CURRENT position. Offsets come back
   * relative to that position, so the caller never has to know where the grid's origin is.
   */
  templateFootprint: ReadonlyArray<number>
  /**
   * Every footprint already standing on the plate, INCLUDING the template's own instance(s).
   * Fill bed adds to a layout rather than redoing it, so all of these hold their ground.
   */
  occupiedFootprints: ReadonlyArray<ReadonlyArray<number>>
  /** Stop after this many copies (default {@link MAX_FILL_BED_COPIES}). */
  maxCopies?: number
}

/**
 * Plan BambuStudio's "Fill bed with copies": how many copies of one object still fit around what
 * is already on the plate, and where. Returns mm offsets from the template's current position,
 * centre-out; an empty array means nothing more fits.
 *
 * Nothing already placed is moved — that is the whole difference from {@link arrangePlateItems},
 * and it matches Studio, whose `FillBedJob` leaves existing instances alone (`priority > 0`) and
 * only positions the new copies.
 *
 * One pass over the candidate anchors places every copy, rather than the general packer's search
 * per item: the copies are CONGRUENT, so a spot rejected for one is rejected for all, and re-testing
 * from the plate centre per copy is what made Studio's own NFP path too slow to use here
 * (its STUDIO-18064 grid fast path exists for the same reason).
 */
export function planFillBedCopies(options: FillBedOptions): Array<{ dx: number; dy: number }> {
  const template = options.templateFootprint.map(decodeFootprintCellKey)
  if (template.length === 0) return []
  const grid = createOccupancyGrid(options)
  if (!grid) return []

  for (const footprint of options.occupiedFootprints) {
    grid.stamp(footprint.map(decodeFootprintCellKey), 0, 0, 1)
  }

  const bounds = cellBounds(template)
  const templateCenterCX = (bounds.minCX + bounds.maxCX) / 2
  const templateCenterCY = (bounds.minCY + bounds.maxCY) / 2
  const halfW = Math.ceil((bounds.maxCX - bounds.minCX) / 2)
  const halfH = Math.ceil((bounds.maxCY - bounds.minCY) / 2)
  const maxCopies = Math.min(options.maxCopies ?? MAX_FILL_BED_COPIES, MAX_FILL_BED_COPIES)

  const offsets: Array<{ dx: number; dy: number }> = []
  for (const [tx, ty] of grid.candidatesFromCentre()) {
    if (offsets.length >= maxCopies) break
    if (tx - halfW < grid.minCX || tx + halfW > grid.maxCX || ty - halfH < grid.minCY || ty + halfH > grid.maxCY) continue
    const dx = Math.round(tx - templateCenterCX)
    const dy = Math.round(ty - templateCenterCY)
    if (!grid.fits(template, dx, dy)) continue
    grid.stamp(template, dx, dy, 1)
    offsets.push({ dx: dx * FOOTPRINT_CELL_MM, dy: dy * FOOTPRINT_CELL_MM })
  }
  return offsets
}
