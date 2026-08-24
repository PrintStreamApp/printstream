/**
 * Align and distribute a multi-selection: the pure arithmetic behind BambuStudio's
 * "Align/Distribute" submenu (`MenuFactory::append_menu_item_align_distribute`,
 * `GUI_Factories.cpp:1949`, implemented in `Gizmos/GLGizmoAlignment.cpp`).
 *
 * OWNS the twelve operations' offsets and nothing else: no Three.js, no scene, no React. Callers
 * hand it each member's extent on ONE axis and apply the offsets it returns. That split exists
 * because the interesting part is the arithmetic, and the arithmetic has cases (an already-aligned
 * member, an even spread, fewer members than an operation needs) that are miserable to exercise
 * through a viewport.
 *
 * PORTED, not invented. Two rules are Studio's and are easy to get wrong by writing what seems
 * reasonable instead:
 *
 * - ALIGN reduces over the members' own bounding boxes and moves each by `reference - current` on
 *   that axis alone (`align_objects_generic`, `:403-421`). The reference is the extreme ALREADY
 *   PRESENT in the selection, so aligning never moves the selection as a whole and one member
 *   always stays put.
 * - DISTRIBUTE equalises CENTRES, not gaps (`distribute_objects_generic`, `:495-514`). It sorts by
 *   centre, spans `(maxCentre - minCentre) / (n - 1)`, and moves only the INTERIOR members: the two
 *   extremes never move. Equal centres and equal gaps are the same thing only when every member is
 *   the same size, which is exactly the case a hand-rolled version is tested against and passes.
 *
 * Studio skips a move under `1e-6` rather than writing a no-op transform; the same threshold is
 * applied here so a member that is already in place is reported as a zero offset and callers can
 * skip it wholesale.
 */

/** Which axis an operation works on. Z is legal: Studio offers align top/bottom/centre in Z. */
export type AlignAxis = 'x' | 'y' | 'z'

/** Where along the axis the members line up. */
export type AlignMode = 'min' | 'center' | 'max'

/** One member's extent on the axis being operated on, in world mm. */
export interface AlignMember {
  key: string
  min: number
  max: number
}

/** Below this a move is a no-op; mirrors Studio's own `1e-6` guard. */
const MOVE_EPSILON = 1e-6

const centreOf = (member: AlignMember): number => (member.min + member.max) / 2

/**
 * How far each member must move along the axis to align, keyed by member.
 *
 * The reference is taken from the selection itself (its lowest `min`, highest `max`, or the centre
 * of its combined box), so the selection never moves as a whole and at least one member stays
 * exactly where it was. Fewer than two members yields no offsets: aligning one object to itself is
 * the no-op Studio's own `can_align` fails to exclude (`:520` computes four unused locals and then
 * ignores its `type` argument entirely, leaving the item enabled for a single object).
 */
export function alignOffsets(
  members: ReadonlyArray<AlignMember>,
  mode: AlignMode
): Map<string, number> {
  const offsets = new Map<string, number>()
  if (members.length < 2) return offsets

  const target = mode === 'min'
    ? Math.min(...members.map((member) => member.min))
    : mode === 'max'
      ? Math.max(...members.map((member) => member.max))
      // Centre aligns on the combined box's centre, not the mean of the members' centres: a wide
      // member would otherwise drag the line towards itself.
      : (Math.min(...members.map((member) => member.min)) + Math.max(...members.map((member) => member.max))) / 2

  for (const member of members) {
    const current = mode === 'min' ? member.min : mode === 'max' ? member.max : centreOf(member)
    const delta = target - current
    if (Math.abs(delta) > MOVE_EPSILON) offsets.set(member.key, delta)
  }
  return offsets
}

/**
 * How far each member must move along the axis to sit at an even spacing, keyed by member.
 *
 * Equalises CENTRES between the two extreme centres, moving only the interior members. Needs at
 * least three: with two there is nothing between them to space out, which is why Studio gates
 * distribute on `>= 3` (`can_distribute`, `:533`) where it gates align on `>= 2`.
 *
 * Members are sorted by centre here rather than trusting selection order, which is the order the
 * user happened to click in.
 */
export function distributeOffsets(members: ReadonlyArray<AlignMember>): Map<string, number> {
  const offsets = new Map<string, number>()
  if (members.length < 3) return offsets

  const sorted = [...members].sort((a, b) => centreOf(a) - centreOf(b))
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  const minCentre = centreOf(first)
  const maxCentre = centreOf(last)
  const interval = (maxCentre - minCentre) / (sorted.length - 1)

  // Endpoints are left alone by construction: the loop runs over the interior only.
  for (let index = 1; index < sorted.length - 1; index += 1) {
    const member = sorted[index]!
    const delta = (minCentre + interval * index) - centreOf(member)
    if (Math.abs(delta) > MOVE_EPSILON) offsets.set(member.key, delta)
  }
  return offsets
}

/** One entry in the Align/Distribute menu: what to call it and what it does. */
export interface AlignDistributeOperation {
  id: string
  label: string
  axis: AlignAxis
  /** Absent for a distribute operation. */
  mode?: AlignMode
}

/**
 * The twelve operations, in BambuStudio's own order and wording, including its `(X)` / `(-X)`
 * suffixes -- which are plain label text there, not accelerators (they are concatenated with
 * `" (X)"`, with no `\t`, so wx never parses them as a shortcut).
 */
export const ALIGN_DISTRIBUTE_OPERATIONS: ReadonlyArray<AlignDistributeOperation> = [
  { id: 'distribute-x', label: 'Distribute left-right (X)', axis: 'x' },
  { id: 'distribute-y', label: 'Distribute front-back (Y)', axis: 'y' },
  { id: 'distribute-z', label: 'Distribute top-bottom (Z)', axis: 'z' },
  { id: 'align-x-min', label: 'Align left (-X)', axis: 'x', mode: 'min' },
  { id: 'align-x-center', label: 'Align left-right center (X)', axis: 'x', mode: 'center' },
  { id: 'align-x-max', label: 'Align right (+X)', axis: 'x', mode: 'max' },
  { id: 'align-y-min', label: 'Align front (-Y)', axis: 'y', mode: 'min' },
  { id: 'align-y-center', label: 'Align front-back center (Y)', axis: 'y', mode: 'center' },
  { id: 'align-y-max', label: 'Align back (+Y)', axis: 'y', mode: 'max' },
  { id: 'align-z-min', label: 'Align bottom (-Z)', axis: 'z', mode: 'min' },
  { id: 'align-z-center', label: 'Align top-bottom center (Z)', axis: 'z', mode: 'center' },
  { id: 'align-z-max', label: 'Align top (+Z)', axis: 'z', mode: 'max' }
]

/**
 * How many selected objects an operation needs before it does anything.
 *
 * Used to DISABLE the menu row rather than to let it run and appear broken. Studio enables align
 * for a single object (see {@link alignOffsets}) and we deliberately do not.
 */
export function minimumMembersFor(operation: AlignDistributeOperation): number {
  return operation.mode ? 2 : 3
}
