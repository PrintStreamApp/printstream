/**
 * What a plate's packers must treat as unavailable: the reachable rectangle and the blocked cells.
 *
 * Owns ONE answer to "where may an object stand on this plate", shared by Auto-arrange
 * (`arrangePlateItems`) and Fill bed with copies (`planFillBedCopies`). It was inline in the
 * arrange handler until fill bed needed the identical rules; two copies of this would drift into
 * two different ideas of the usable bed, and the symptom (a copy parked where it cannot print)
 * only shows up at slice time.
 *
 * Pure (no Three.js): the caller reads live nozzle assignments and the prime tower's rendered
 * footprint out of the scene and passes plain numbers, so the rules stay unit-testable.
 *
 * Two distinct treatments, and the difference matters:
 * - A NOZZLE-ONLY zone shrinks the reachable RECT, because it constrains a whole edge strip for
 *   any object whose materials need the opposite nozzle.
 * - A truly UNPRINTABLE zone is blocked cell by cell, so a corner cutout costs that corner rather
 *   than the whole edge.
 */
import { FOOTPRINT_CELL_MM, footprintCellKey } from './arrange'

export interface PlateObstacleZone {
  polygon: ReadonlyArray<{ x: number; y: number }>
  /**
   * Which nozzle this zone requires, from `zoneRequiredNozzle`: 0 = right, 1 = left,
   * null when the zone is unprintable outright.
   */
  requiredNozzle: number | null
}

/** The prime tower's live footprint in plate coords (its rendered centre and size, mm). */
export interface PlateObstacleTower {
  centerX: number
  centerY: number
  width: number
  depth: number
}

export interface PlateObstacleInput {
  bed: { minX: number; maxX: number; minY: number; maxY: number }
  zones: ReadonlyArray<PlateObstacleZone>
  /**
   * The nozzle ids required by each object that must remain printable. Auto-arrange passes every
   * instance on the plate; Fill bed passes only the object being copied, since nothing else moves.
   */
  nozzleDemands: ReadonlyArray<ReadonlySet<number>>
  primeTower?: PlateObstacleTower | null
  /** Rasterizer for an unprintable zone's polygon (the editor's `rasterizePolygonCells`). */
  rasterizePolygon: (polygon: ReadonlyArray<{ x: number; y: number }>) => Iterable<number>
}

export interface PlateObstacles {
  /** The rectangle every listed object can actually reach and print in. */
  safeArea: { minX: number; maxX: number; minY: number; maxY: number }
  /** Cells that must stay empty: unprintable zones and the prime tower. */
  blockedCells: Set<number>
}

/** Derive the usable area and blocked cells for packing objects onto a plate. */
export function computePlateObstacles(input: PlateObstacleInput): PlateObstacles {
  // Runtime nozzle ids: 0 = right, 1 = left. A RIGHT-only zone bounds how far right the LEFT
  // nozzle may reach, and vice versa.
  let leftMaxX = input.bed.maxX
  let rightMinX = input.bed.minX
  for (const zone of input.zones) {
    if (zone.requiredNozzle == null) continue
    let zx0 = Infinity, zx1 = -Infinity
    for (const point of zone.polygon) {
      zx0 = Math.min(zx0, point.x); zx1 = Math.max(zx1, point.x)
    }
    if (zone.requiredNozzle === 0) leftMaxX = Math.min(leftMaxX, zx0)
    else if (zone.requiredNozzle === 1) rightMinX = Math.max(rightMinX, zx1)
  }

  let safeMinX = input.bed.minX
  let safeMaxX = input.bed.maxX
  for (const nozzles of input.nozzleDemands) {
    if (nozzles.has(1)) safeMaxX = Math.min(safeMaxX, leftMaxX)
    if (nozzles.has(0)) safeMinX = Math.max(safeMinX, rightMinX)
  }

  const blockedCells = new Set<number>()
  for (const zone of input.zones) {
    if (zone.requiredNozzle != null) continue // handled via the safe rect
    for (const cell of input.rasterizePolygon(zone.polygon)) blockedCells.add(cell)
  }

  const tower = input.primeTower
  if (tower) {
    const halfW = tower.width / 2
    const halfD = tower.depth / 2
    if (halfW > 0 && halfD > 0) {
      for (let cx = Math.floor((tower.centerX - halfW) / FOOTPRINT_CELL_MM); cx <= Math.floor((tower.centerX + halfW) / FOOTPRINT_CELL_MM); cx += 1) {
        for (let cy = Math.floor((tower.centerY - halfD) / FOOTPRINT_CELL_MM); cy <= Math.floor((tower.centerY + halfD) / FOOTPRINT_CELL_MM); cy += 1) {
          blockedCells.add(footprintCellKey(cx, cy))
        }
      }
    }
  }

  return {
    safeArea: { minX: safeMinX, maxX: safeMaxX, minY: input.bed.minY, maxY: input.bed.maxY },
    blockedCells
  }
}
