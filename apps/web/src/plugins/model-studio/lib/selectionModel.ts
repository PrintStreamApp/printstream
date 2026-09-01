/**
 * Pure selection rules for the editor's multi-select, mirroring BambuStudio's
 * object-list semantics:
 *
 * - The selection holds whole objects OR parts (volumes), never a mix: picking one
 *   kind converts the selection to that kind (BambuStudio `Selection::add` resets
 *   rather than mixing modes).
 * - Parts multi-select only WITHIN one object: toggling a part of a different object
 *   replaces the selection with that single part (BambuStudio
 *   `fix_multiselection_conflicts` discards non-siblings).
 * - Shift-click selects the contiguous range from the last plainly-clicked row
 *   (the anchor) to the target, replacing the previous selection but keeping the
 *   anchor as the primary.
 *
 * A BAKED part is keyed geometry-level (`objectId` + the part's ORDINAL `partIndex`), the same
 * identity used by filament reassignment, part-type changes, and per-part process
 * overrides, so a part selection means "this part on every instance of the object".
 */

/**
 * One part of an object, in whichever of the two address spaces names it.
 *
 * A part baked into the project's 3MF is named by its ordinal; a volume added this session is named
 * by its own key, because it has no ordinal until a save gives it one. That difference is an
 * implementation detail of the SAVE and is invisible to the user, so it is confined to this type and
 * its codec -- see the part-is-a-part rule in this plugin'the s development notes. Everything downstream takes a
 * member and only asks which kind it is where the two genuinely differ (where the settings are
 * stored, which write-back a drag routes to).
 */
export type PartMember =
  | { kind: 'baked'; partIndex: number }
  | { kind: 'added'; key: string }
  /**
   * The object's OWN geometry, for an object whose `parts` list does not describe it.
   *
   * A single-solid import (STL, primitive, cut half, an earlier boolean result) and a single-mesh
   * object in a saved project both report `parts: []` and keep their body on the instance's own
   * mesh. BambuStudio lists a row per volume as soon as an object has TWO, and none when it has one
   * (`ObjectList` rebuilds the children over every volume on a split/add, and folds them away again
   * on delete), so the body earns a row exactly when something else has been added beside it.
   * Without this kind that row has nothing to select, which is why the object row was the only thing
   * standing in for the body.
   */
  | { kind: 'body' }

/**
 * A member as one opaque string, for the places that need to compare, order or de-duplicate members
 * without caring which space they came from (range selection, the scene's per-frame box keys).
 *
 * An added part's key is arbitrary data and may contain the separator, so decoding takes everything
 * after the FIRST one rather than splitting: a truncated key matches no volume, and the member would
 * silently address nothing instead of failing.
 */
export function partMemberKey(member: PartMember): string {
  if (member.kind === 'body') return BODY_MEMBER_KEY
  return member.kind === 'baked' ? `baked:${member.partIndex}` : `added:${member.key}`
}

/**
 * The body's key. Separator-free on purpose: an added part's key is user data and could be the
 * literal string `body`, so a `body:` prefix would be forgeable, while nothing encodes to a bare
 * `body` except the body itself.
 */
const BODY_MEMBER_KEY = 'body'

/** Decode {@link partMemberKey}, or null when the string names no part. */
export function parsePartMember(key: string): PartMember | null {
  if (key === BODY_MEMBER_KEY) return { kind: 'body' }
  if (key.startsWith('baked:')) {
    const partIndex = Number(key.slice('baked:'.length))
    return Number.isFinite(partIndex) ? { kind: 'baked', partIndex } : null
  }
  if (key.startsWith('added:')) {
    const addedKey = key.slice('added:'.length)
    return addedKey.length > 0 ? { kind: 'added', key: addedKey } : null
  }
  return null
}

/** Whether two members name the same part. The two address spaces are disjoint, so this cannot confuse them. */
export function samePartMember(a: PartMember, b: PartMember): boolean {
  if (a.kind === 'baked') return b.kind === 'baked' && a.partIndex === b.partIndex
  if (a.kind === 'added') return b.kind === 'added' && a.key === b.key
  return b.kind === 'body'
}

/** Whether a member is in a set, by identity rather than object reference. */
export function selectionHasMember(members: ReadonlyArray<PartMember>, member: PartMember): boolean {
  return members.some((entry) => samePartMember(entry, member))
}

/**
 * Selected parts of ONE object (BambuStudio volume-mode selection).
 *
 * `members` replaced an earlier `partIndexes: number[]`, which could only hold baked parts: a
 * session-added volume lived in a separate single-value state and so could not join a multi-part
 * selection at all, which split the sidebar into rows that multi-select and rows that do not, with
 * no visible reason why. The rename is what forced every consumer to be revisited rather than
 * compiling unchanged against a widened meaning -- a mixed selection that only some actions honour
 * would be worse than the split it replaced.
 */
export interface PartSelection {
  /** Owning object id (a baked object's Bambu id, or an import's synthetic identity). */
  objectId: number
  /** The selected parts, in selection order (first = anchor). */
  members: ReadonlyArray<PartMember>
}

/**
 * Ctrl/Cmd-click semantics for a part row: toggle within the same object; a part of a
 * DIFFERENT object converts the selection to just that part. Returns null when the
 * last part is toggled off.
 */
export function togglePartInSelection(
  current: PartSelection | null,
  objectId: number,
  member: PartMember
): PartSelection | null {
  if (!current || current.objectId !== objectId) {
    return { objectId, members: [member] }
  }
  if (selectionHasMember(current.members, member)) {
    const rest = current.members.filter((entry) => !samePartMember(entry, member))
    return rest.length > 0 ? { objectId, members: rest } : null
  }
  return { objectId, members: [...current.members, member] }
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
  /** The object's parts in SIDEBAR order, both kinds interleaved as the user sees them. */
  orderedMembers: ReadonlyArray<PartMember>,
  anchor: { objectId: number; member: PartMember } | null,
  target: PartMember
): PartSelection {
  // Ranged in KEY space, so a range spans both kinds: the rows being dragged across are one list on
  // screen, and a range that silently skipped the volumes in the middle would select something other
  // than what was highlighted.
  const orderedKeys = orderedMembers.map(partMemberKey)
  const anchorKey = anchor && anchor.objectId === objectId ? partMemberKey(anchor.member) : null
  return {
    objectId,
    members: rangeSlice(orderedKeys, anchorKey, partMemberKey(target))
      .map(parsePartMember)
      .filter((member): member is PartMember => member !== null)
  }
}

/**
 * Drop selected parts that no longer exist (object deleted, parts changed by an
 * undo/replace, a volume removed). `ownerMembers` is the owning object's current parts of BOTH
 * kinds, or null when no instance of the object remains anywhere in the project.
 */
export function prunePartSelection(
  current: PartSelection | null,
  ownerMembers: ReadonlyArray<PartMember> | null
): PartSelection | null {
  if (!current) return null
  if (!ownerMembers) return null
  const kept = current.members.filter((entry) => selectionHasMember(ownerMembers, entry))
  if (kept.length === 0) return null
  return kept.length === current.members.length ? current : { ...current, members: kept }
}

/** A part addressed the way the selection model addresses one: object id plus the member. */
export interface PartRef {
  objectId: number
  member: PartMember
}

/** Whether two part refs name the same part of the same object. */
export function samePartRef(a: PartRef | null, b: PartRef | null): boolean {
  if (!a || !b) return a === b
  return a.objectId === b.objectId && samePartMember(a.member, b.member)
}

/**
 * What opening a part row's context menu should do to the selection, and what the menu acts on.
 *
 * A menu SELECTS what it is opened on, matching BambuStudio: its `ObjectList::show_context_menu`
 * chooses which menu to show from `GetSelection()`, and the native list moves the selection to the
 * clicked row before the event fires (Studio patches the one platform where it does not). It never
 * deselects, so a row already selected is left alone.
 *
 * The subtlety is that a part can be selected in EITHER of two ways, and only one used to be
 * checked. A plain click on a part that owns a mesh group hands that group the gizmo and KEEPS the
 * object selected (`selectedKey` + `gizmoPart`); the bulk path is for parts that cannot take a
 * gizmo, and for multi-select, and it clears the object selection. Forcing the bulk path here
 * cleared `selectedKey` even for a gizmo-capable part, which made M/R/S inert and reset every mode
 * that is inert without a selection (Cut, the paint channels, Brim ears, Layer height).
 *
 * `selectFirst` false means the row is already selected one of the two ways.
 */
export function partRowMenuSelection(
  target: PartRef,
  bulk: PartSelection | null,
  gizmoPart: PartRef | null,
  selectedKey: string | null,
  instanceKey: string
): { selectFirst: boolean; members: ReadonlyArray<PartMember> } {
  const inBulk = bulk != null && bulk.objectId === target.objectId
    && selectionHasMember(bulk.members, target.member)
  const hasGizmo = samePartRef(gizmoPart, target) && selectedKey === instanceKey
  // A bulk set is what the menu acts on when the row belongs to one, so Delete over a multi-part
  // selection removes the set rather than the one row the menu was summoned from.
  return { selectFirst: !inBulk && !hasGizmo, members: inBulk ? bulk.members : [target.member] }
}

/**
 * Whether ANYTHING is selected, across every shape the editor holds a selection in.
 *
 * Exists because "is something selected" is not one field. An object selection lives in
 * `selectedKey`, but the part shapes do not touch it -- the bulk part path deliberately nulls
 * `selectedKey` first -- so asking `selectedKey != null` reports "nothing selected" while a part is
 * plainly highlighted. Escape read exactly that and closed the whole editor over a live part
 * selection instead of clearing it.
 *
 * Kept here, next to the rules that CREATE those shapes, so another one cannot be added without this
 * being the obvious place to register it. Callers that clear a selection must clear them all;
 * reporting a selection this does not clear turns Escape into a key that does nothing. There used to
 * be FOUR shapes, because a session-added volume was held in a state of its own; folding it into
 * {@link PartSelection} and {@link PartRef} is what removed the one every clearing site forgot.
 */
export function hasEditorSelection(selection: {
  /** The primary object instance key, if an OBJECT selection is active. */
  objectKey: string | null
  /** The selected parts of one object, of either kind. */
  partSelection: PartSelection | null
  /** The single part holding the gizmo, which keeps the object selected alongside it. */
  gizmoPart: PartRef | null
}): boolean {
  return selection.objectKey != null || selection.partSelection != null || selection.gizmoPart != null
}
