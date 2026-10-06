/**
 * Routes a selected mix of body, baked, and session-added parts to their storage owners. A user
 * gesture records one history checkpoint even when several owners must write. Body material
 * changes exclude unselected added volumes; whole-object material changes use a separate path.
 */
import type { SceneEditPartSubtype } from '@printstream/shared'
import { addedPartHostId, BODY_PART_INDEX, type EditorState } from './editorModel'
import type { PartMember } from './selectionModel'

type BakedTarget = { objectId: number; partIndex: number }
type HistoryOption = { recordHistory?: boolean }

interface MemberTypeChange {
  objectId: number
  members: ReadonlyArray<PartMember>
  subtype: SceneEditPartSubtype
  recordHistory: () => void
  changeBaked: (targets: BakedTarget[], subtype: SceneEditPartSubtype, options?: HistoryOption) => void
  changeAdded: (keys: string[], subtype: SceneEditPartSubtype, options?: HistoryOption) => void
}

/** Retype the selected members, including an unbaked body at its eventual part ordinal. */
export function changeEditorMemberTypes(options: MemberTypeChange): void {
  const baked: BakedTarget[] = []
  const added: string[] = []
  for (const member of options.members) {
    if (member.kind === 'baked') baked.push({ objectId: options.objectId, partIndex: member.partIndex })
    if (member.kind === 'body') baked.push({ objectId: options.objectId, partIndex: BODY_PART_INDEX })
    if (member.kind === 'added') added.push(member.key)
  }
  const mixed = baked.length > 0 && added.length > 0
  if (mixed) options.recordHistory()
  const history = { recordHistory: !mixed }
  if (baked.length > 0) options.changeBaked(baked, options.subtype, history)
  if (added.length > 0) options.changeAdded(added, options.subtype, history)
}

interface MemberFilamentChange {
  objectId: number
  members: ReadonlyArray<PartMember>
  filamentId: number
  state: EditorState | null
  recordHistory: () => void
  changeBody: (
    keys: string[], filamentId: number,
    options: HistoryOption & { includeVolumes: false }
  ) => void
  changeBaked: (targets: BakedTarget[], filamentId: number, options?: HistoryOption) => void
  changeAdded: (keys: string[], filamentId: number, options?: HistoryOption) => void
}

/** Change only the selected members' materials, with one checkpoint across owner seams. */
export function changeEditorMemberFilament(options: MemberFilamentChange): void {
  const owner = options.members.some((member) => member.kind === 'body')
    ? options.state?.plates.flatMap((plate) => plate.instances)
      .find((instance) => addedPartHostId(instance) === options.objectId)
    : null
  const baked: BakedTarget[] = []
  const added: string[] = []
  for (const member of options.members) {
    if (member.kind === 'baked') baked.push({ objectId: options.objectId, partIndex: member.partIndex })
    if (member.kind === 'added') added.push(member.key)
  }
  const seamCount = Number(Boolean(owner)) + Number(baked.length > 0) + Number(added.length > 0)
  if (seamCount > 1) options.recordHistory()
  const history = { recordHistory: seamCount <= 1 }

  if (owner) {
    options.changeBody([owner.key], options.filamentId, { ...history, includeVolumes: false })
  }
  if (baked.length > 0) options.changeBaked(baked, options.filamentId, history)
  if (added.length > 0) options.changeAdded(added, options.filamentId, history)
}
