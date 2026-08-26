/**
 * The pure rules for height range bands: where a new one fits, and how moving one edge stays
 * inside its neighbours.
 *
 * Separate from `HeightRangesDialog` so the rules are unit-testable without rendering (and so the
 * dialog file exports only its component). Z values are OBJECT space mm, z=0 at the object's
 * underside — the frame `Metadata/layer_config_ranges.xml` stores and the slicer reads.
 *
 * The deliberate divergence from BambuStudio is that bands here can never overlap. Studio lets
 * overlaps exist and resolves them at slice time by trimming the lower band's top away
 * (`Slicing.cpp:181-182`), so the plate does not print what its UI showed.
 */
import type { EditorHeightRange } from './editorModel'

/** Studio seeds its first band 2mm tall; a band added after one continues that. */
export const DEFAULT_BAND_HEIGHT_MM = 2

/**
 * Thinnest band worth keeping. Below this a band cannot hold even the finest layer, and
 * BambuStudio silently drops it ("Ignore too narrow ranges", `Slicing.cpp:183-185`).
 */
export const MIN_BAND_HEIGHT_MM = 0.04

/** Bands sorted by start, so a list always reads bottom-up regardless of edit order. */
export function sortBands(ranges: ReadonlyArray<EditorHeightRange>): EditorHeightRange[] {
  return [...ranges].sort((a, b) => a.minZ - b.minZ || a.maxZ - b.maxZ)
}

/**
 * Where a new band fits: stacked on the highest existing one, else from the object's base.
 *
 * Returns null when the model has no room left, so the caller can DISABLE its add control rather
 * than silently doing nothing — which is what BambuStudio's always-enabled `+` does once
 * `can_add_new_range_after_current` was gutted to always report "addable".
 */
export function nextBandSlot(
  ranges: ReadonlyArray<EditorHeightRange>,
  objectHeightMm: number | null
): { minZ: number; maxZ: number } | null {
  const ceiling = objectHeightMm ?? Number.POSITIVE_INFINITY
  const top = ranges.reduce((highest, range) => Math.max(highest, range.maxZ), 0)
  if (top + MIN_BAND_HEIGHT_MM > ceiling) return null
  return { minZ: top, maxZ: Math.min(top + DEFAULT_BAND_HEIGHT_MM, ceiling) }
}

/**
 * Move one edge of the band at `index`, clamped so bands stay ordered and never overlap: a
 * neighbour's facing edge is the hard stop, the band's own opposite edge keeps it at least
 * {@link MIN_BAND_HEIGHT_MM} tall, and the top band is bounded by the object's height.
 *
 * Returns the complete new set (deep-copied), or null when the edit cannot apply.
 */
export function moveBandEdge(
  ranges: ReadonlyArray<EditorHeightRange>,
  index: number,
  edge: 'minZ' | 'maxZ',
  value: number,
  objectHeightMm: number | null
): EditorHeightRange[] | null {
  if (!Number.isFinite(value)) return null
  const next = sortBands(ranges).map((range) => ({ ...range, settings: { ...range.settings } }))
  const band = next[index]
  if (!band) return null
  if (edge === 'minZ') {
    const floor = index > 0 ? next[index - 1]!.maxZ : 0
    band.minZ = Math.min(Math.max(value, floor), band.maxZ - MIN_BAND_HEIGHT_MM)
  } else {
    const ceiling = index < next.length - 1
      ? next[index + 1]!.minZ
      : (objectHeightMm ?? Number.POSITIVE_INFINITY)
    band.maxZ = Math.max(Math.min(value, ceiling), band.minZ + MIN_BAND_HEIGHT_MM)
  }
  return next
}
