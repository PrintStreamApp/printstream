/**
 * Pure geometry for a drag-to-reorder tile list (the editor's plate strip, the materials list): which insertion gap a pointer position means,
 * and where to draw the insertion caret. Kept free of DOM/React so the mapping is unit-testable;
 * `hooks/useListReorderDrag.ts` owns the pointer-event state machine that feeds it.
 *
 * The strip drops BETWEEN tiles (insertion gaps 0..N), never onto a tile: a drop onto a tile is
 * ambiguous — "insert after" when dragging forward and "insert before" when dragging backward
 * mean different landings from the same drop point — while a gap means one position in both
 * directions and both orientations.
 */

/** One tile's extent along the strip axis, in any consistent coordinate space. */
export interface ListTileExtent {
  start: number
  end: number
}

/**
 * The insertion gap (0..tiles.length) a pointer coordinate lands in: the number of tiles whose
 * midpoint sits before the pointer. Dragging over a tile's leading half inserts before it,
 * trailing half after it.
 */
export function listInsertionGap(tiles: readonly ListTileExtent[], pointer: number): number {
  let gap = 0
  for (const tile of tiles) {
    if (pointer > (tile.start + tile.end) / 2) gap += 1
  }
  return gap
}

/**
 * Centre of the insertion caret for `gap`, along the strip axis in the tiles' coordinate space.
 * Between two tiles it is the middle of the gap between them; past either end it sits just
 * outside the terminal tile. Null when there are no tiles to anchor to.
 */
export function listInsertionCaretCenter(tiles: readonly ListTileExtent[], gap: number): number | null {
  if (tiles.length === 0) return null
  const clamped = Math.max(0, Math.min(tiles.length, gap))
  if (clamped === 0) return tiles[0]!.start - 2
  if (clamped === tiles.length) return tiles[tiles.length - 1]!.end + 2
  return (tiles[clamped - 1]!.end + tiles[clamped]!.start) / 2
}
