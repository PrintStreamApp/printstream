/**
 * Pure selection rules for the editor's multi-select, mirroring BambuStudio's
 * object-list semantics:
 *
 * - The selection holds whole objects OR parts (volumes), never a mix — picking one
 *   kind converts the selection to that kind (BambuStudio `Selection::add` resets
 *   rather than mixing modes).
 * - Parts multi-select only WITHIN one object: toggling a part of a different object
 *   replaces the selection with that single part (BambuStudio
 *   `fix_multiselection_conflicts` discards non-siblings).
 * - Shift-click selects the contiguous range from the last plainly-clicked row
 *   (the anchor) to the target, replacing the previous selection but keeping the
 *   anchor as the primary.
 *
 * Parts are keyed geometry-level (`objectId` + `componentObjectId`) — the same
 * identity used by filament reassignment, part-type changes, and per-part process
 * overrides — so a part selection means "this part on every instance of the object".
 */

/** Selected parts of ONE object (BambuStudio volume-mode selection). */
export interface PartSelection {
  /** Owning object id (a baked object's Bambu id, or an import's synthetic identity). */
  objectId: number
  /** The selected parts' component object ids, in selection order (first = anchor). */
  componentObjectIds: ReadonlyArray<number>
}

/**
 * Ctrl/Cmd-click semantics for a part row: toggle within the same object; a part of a
 * DIFFERENT object converts the selection to just that part. Returns null when the
 * last part is toggled off.
 */
export function togglePartInSelection(
  current: PartSelection | null,
  objectId: number,
  componentObjectId: number
): PartSelection | null {
  if (!current || current.objectId !== objectId) {
    return { objectId, componentObjectIds: [componentObjectId] }
  }
  if (current.componentObjectIds.includes(componentObjectId)) {
    const rest = current.componentObjectIds.filter((id) => id !== componentObjectId)
    return rest.length > 0 ? { objectId, componentObjectIds: rest } : null
  }
  return { objectId, componentObjectIds: [...current.componentObjectIds, componentObjectId] }
}

/**
 * Shift-click range in an ordered row list: every entry between the anchor and the
 * target inclusive, anchor first (so the anchor stays the primary). Falls back to
 * just the target when the anchor is absent from the list.
 */
export function rangeSlice<T>(ordered: ReadonlyArray<T>, anchor: T | null, target: T): T[] {
  const anchorIndex = anchor === null ? -1 : ordered.indexOf(anchor)
  const targetIndex = ordered.indexOf(target)
  if (anchorIndex === -1 || targetIndex === -1) return [target]
  const [lo, hi] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
  const slice = ordered.slice(lo, hi + 1)
  return anchorIndex <= targetIndex ? slice : slice.reverse()
}

/**
 * Shift-click on a part row: a contiguous range of the object's parts from the anchor
 * part to the target. An anchor on a different object doesn't apply (BambuStudio
 * restricts part ranges to siblings), so the selection converts to just the target.
 */
export function rangePartSelection(
  objectId: number,
  orderedComponentIds: ReadonlyArray<number>,
  anchor: { objectId: number; componentObjectId: number } | null,
  targetComponentId: number
): PartSelection {
  const anchorId = anchor && anchor.objectId === objectId ? anchor.componentObjectId : null
  return { objectId, componentObjectIds: rangeSlice(orderedComponentIds, anchorId, targetComponentId) }
}

/**
 * Drop selected parts that no longer exist (object deleted, parts changed by an
 * undo/replace). `ownerComponentIds` is the owning object's current part ids, or null
 * when no instance of the object remains anywhere in the project.
 */
export function prunePartSelection(
  current: PartSelection | null,
  ownerComponentIds: ReadonlyArray<number> | null
): PartSelection | null {
  if (!current) return null
  if (!ownerComponentIds) return null
  const kept = current.componentObjectIds.filter((id) => ownerComponentIds.includes(id))
  if (kept.length === 0) return null
  return kept.length === current.componentObjectIds.length ? current : { ...current, componentObjectIds: kept }
}
