/**
 * Keep the purge/prime tower inside the area EVERY extruder can reach.
 *
 * OWNS the nozzle-reach rule for the tower, as a pure geometry helper. Two consumers:
 * `computePlacementWarnings` (editorGeometry.ts) reports a violation, and `EditorView`'s tower drag
 * clamps against it so the user cannot create one in the first place.
 *
 * WHY. On a dual-nozzle machine each extruder reaches its own rectangle, and the strips only one of
 * them can reach are published on the scene's bed as exclude zones labelled "Left/Right nozzle
 * only" (`computeNozzleOnlyZones` in the shared scene parser). For an OBJECT such a strip is merely
 * a constraint: printing it there is fine as long as it uses only that nozzle, which is what the
 * per-object check tests. **The tower is different in kind: every filament purges into it, so it is
 * used by every extruder.** A tower in a single-nozzle strip is therefore unprintable no matter how
 * the materials are assigned: the other nozzle physically cannot get to it.
 *
 * BambuStudio agrees and says so in its own words: on a machine switch its CLI notes the tower "may
 * have been placed in a single-nozzle-only zone from the source printer" and shifts it into the
 * shared area (`BambuStudio.cpp`, the `shrink_to_new_bed == 0` branch), where "shared" is
 * `Print::get_extruder_shared_printable_polygon()`: the INTERSECTION of every extruder's printable
 * area. We enforce the same rule earlier, while the user is placing it.
 *
 * Only nozzle-only zones are considered here. Ordinary unprintable zones (the X1/P1 corner cutout)
 * are a separate concern and are already reported for objects; folding them in would change what
 * the tower warning means.
 */
import { zoneRequiredNozzle } from '../editorGeometry'

/** An axis-aligned footprint in plate-local millimetres. */
export interface TowerRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

interface ExcludeZoneLike {
  polygon: Array<{ x: number; y: number }>
  label: string | null
}

/** Overlaps by more than a rounding sliver. Touching edges are not a reach problem. */
const OVERLAP_TOLERANCE_MM = 0.5

function boundsOf(polygon: Array<{ x: number; y: number }>): TowerRect | null {
  if (polygon.length === 0) return null
  const xs = polygon.map((point) => point.x)
  const ys = polygon.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

/** The bounds of each zone only ONE nozzle can reach, paired with that zone's label. */
export function nozzleOnlyZoneBounds(
  excludeAreas: readonly ExcludeZoneLike[]
): Array<{ bounds: TowerRect; label: string }> {
  const zones: Array<{ bounds: TowerRect; label: string }> = []
  for (const zone of excludeAreas) {
    if (zoneRequiredNozzle(zone.label) == null) continue
    const bounds = boundsOf(zone.polygon)
    // `zoneRequiredNozzle` only returns non-null for a labelled zone, so the label is present.
    if (bounds && zone.label) zones.push({ bounds, label: zone.label })
  }
  return zones
}

function overlaps(a: TowerRect, b: TowerRect): boolean {
  return a.minX < b.maxX - OVERLAP_TOLERANCE_MM
    && a.maxX > b.minX + OVERLAP_TOLERANCE_MM
    && a.minY < b.maxY - OVERLAP_TOLERANCE_MM
    && a.maxY > b.minY + OVERLAP_TOLERANCE_MM
}

/**
 * The user-facing reason the tower cannot be printed where it is, or null when it is fine.
 *
 * Names the zone as the machine does ("Left nozzle only"), because that is the label drawn on the
 * plate: the user can see the region the message is talking about.
 */
export function primeTowerReachIssue(
  tower: TowerRect | null,
  excludeAreas: readonly ExcludeZoneLike[]
): string | null {
  if (!tower) return null
  for (const { bounds, label } of nozzleOnlyZoneBounds(excludeAreas)) {
    if (overlaps(tower, bounds)) {
      return `sits in the ${label.toLowerCase()} area, which the other nozzle cannot reach to purge into`
    }
  }
  return null
}

/**
 * Nudge a tower rect out of every nozzle-only zone, keeping it on the plate.
 *
 * Moves along the axis of LEAST penetration so a drag lands as close as possible to where the user
 * aimed, rather than jumping across the bed. Returns the corrected MIN corner (what the editor
 * stores as the tower position). Zones are re-tested after each shift because pushing clear of one
 * strip can slide the tower into the opposite one on a narrow bed; if no free spot is reachable the
 * last position is returned rather than looping, a tower that cannot fit the shared area is a
 * warning to surface, not something to solve by moving it somewhere equally wrong.
 */
export function clampPrimeTowerIntoReach(
  tower: TowerRect,
  bed: { minX: number; maxX: number; minY: number; maxY: number },
  excludeAreas: readonly ExcludeZoneLike[]
): { x: number; y: number } {
  const zones = nozzleOnlyZoneBounds(excludeAreas)
  const width = tower.maxX - tower.minX
  const depth = tower.maxY - tower.minY
  let current: TowerRect = { ...tower }

  // One pass per zone is enough to settle in practice; the bound just stops a pathological bed
  // (overlapping strips leaving no gap) from spinning here.
  for (let pass = 0; pass < zones.length + 1; pass += 1) {
    const hit = zones.find((zone) => overlaps(current, zone.bounds))
    if (!hit) break
    const pushLeft = current.maxX - hit.bounds.minX
    const pushRight = hit.bounds.maxX - current.minX
    const pushDown = current.maxY - hit.bounds.minY
    const pushUp = hit.bounds.maxY - current.minY
    const smallest = Math.min(pushLeft, pushRight, pushDown, pushUp)
    let minX = current.minX
    let minY = current.minY
    if (smallest === pushLeft) minX = hit.bounds.minX - width - OVERLAP_TOLERANCE_MM
    else if (smallest === pushRight) minX = hit.bounds.maxX + OVERLAP_TOLERANCE_MM
    else if (smallest === pushDown) minY = hit.bounds.minY - depth - OVERLAP_TOLERANCE_MM
    else minY = hit.bounds.maxY + OVERLAP_TOLERANCE_MM
    // Never push it off the plate to satisfy a zone; a tower wider than the gap stays put and is
    // reported instead.
    minX = Math.min(Math.max(minX, bed.minX), bed.maxX - width)
    minY = Math.min(Math.max(minY, bed.minY), bed.maxY - depth)
    if (minX === current.minX && minY === current.minY) break
    current = { minX, maxX: minX + width, minY, maxY: minY + depth }
  }

  return { x: current.minX, y: current.minY }
}
