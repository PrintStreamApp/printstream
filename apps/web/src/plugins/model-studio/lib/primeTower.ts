/**
 * Prime/wipe tower footprint sizing, ported from BambuStudio's prepare-mode estimate
 * (`PartPlate::estimate_wipe_tower_size` + `WipeTower::get_limit_depth_by_height`,
 * src/slic3r/GUI/PartPlate.cpp / src/libslic3r/GCode/WipeTower.cpp).
 *
 * BambuStudio does NOT draw the prepare-view tower as `prime_tower_width` squared. With rib
 * walls (the default) the footprint is a square whose side grows with the total purge volume
 * (per-filament prime volume x filament count), the layer height and the infill gap, then is
 * floored by a height-dependent minimum and padded by the rib geometry. The config inputs come
 * from the parsed 3MF; the filament count and tallest-object height are only known once the
 * editor scene is built, so the final size is computed here on the client.
 */
import type { LibraryThreeMfPrimeTowerSizing } from '@printstream/shared'

/** Square footprint (mm) of the rendered prepare-mode tower. */
export interface WipeTowerFootprint {
  width: number
  depth: number
}

/**
 * BambuStudio's `min_depth_per_height` table with linear interpolation: taller towers need a
 * deeper minimum footprint so they stay stable. Heights below the first / above the last entry
 * clamp to that entry's depth.
 */
const MIN_DEPTH_BY_HEIGHT: ReadonlyArray<readonly [height: number, depth: number]> = [
  [5, 5],
  [100, 20],
  [250, 40],
  [350, 60]
]

/** Port of `WipeTower::get_limit_depth_by_height`. */
export function wipeTowerMinDepth(maxHeight: number): number {
  const first = MIN_DEPTH_BY_HEIGHT[0]!
  if (maxHeight <= first[0]) return first[1]
  for (let i = 0; i < MIN_DEPTH_BY_HEIGHT.length - 1; i += 1) {
    const [h0, d0] = MIN_DEPTH_BY_HEIGHT[i]!
    const [h1, d1] = MIN_DEPTH_BY_HEIGHT[i + 1]!
    if (h1 > maxHeight) return d0 + ((maxHeight - h0) / (h1 - h0)) * (d1 - d0)
  }
  return MIN_DEPTH_BY_HEIGHT[MIN_DEPTH_BY_HEIGHT.length - 1]![1]
}

/**
 * Footprint of the prepare-mode prime tower, matching BambuStudio's estimate.
 *
 * @param sizing            config inputs parsed from the 3MF
 * @param width             `prime_tower_width` (the X extent when rib walls are disabled)
 * @param plateFilamentCount number of distinct filaments printed on this plate (`plate_extruder_size`)
 * @param maxHeight         tallest printed object on the plate (mm)
 *
 * Falls back to a `width` x `width` square if the inputs can't produce a finite size.
 */
export function estimateWipeTowerFootprint(
  sizing: LibraryThreeMfPrimeTowerSizing,
  width: number,
  plateFilamentCount: number,
  maxHeight: number
): WipeTowerFootprint {
  const square = (side: number): WipeTowerFootprint => ({ width: side, depth: side })
  if (plateFilamentCount <= 0) return square(width)

  const layerHeight = sizing.layerHeight > 0 ? sizing.layerHeight : 0.08
  const extraSpacing = sizing.infillGap
  // Single-nozzle purges (count - 1) transitions; dual-nozzle purges all `count` slots. The
  // dual-nozzle filament-change volume term needs config we don't carry, so it's omitted (it
  // only applies to the rare two-nozzle printers and nudges the size up slightly).
  const volume = sizing.wipeVolume * (sizing.extruderCount === 2 ? plateFilamentCount : plateFilamentCount - 1)
  const forced = sizing.needWipeTower || plateFilamentCount > 1

  if (sizing.ribWall) {
    let depth = Math.sqrt((volume / layerHeight) * extraSpacing)
    if (forced) {
      const volumeDepth = depth
      depth = Math.max(wipeTowerMinDepth(maxHeight), depth)
      const ribWidth = Math.min(sizing.ribWidth, depth / 2)
      depth = ribWidth / Math.SQRT2 + Math.max(depth + sizing.extraRibLength, volumeDepth)
    }
    return Number.isFinite(depth) && depth > 0 ? square(depth) : square(width)
  }

  let depth = (volume / (layerHeight * width)) * extraSpacing
  if (forced || depth > 1e-6) {
    depth = Math.max(wipeTowerMinDepth(maxHeight), depth)
  }
  return Number.isFinite(depth) && depth > 0 ? { width, depth } : square(width)
}
