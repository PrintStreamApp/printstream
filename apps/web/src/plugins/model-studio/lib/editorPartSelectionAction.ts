/**
 * Owns sidebar part-row selection. Plain clicks use a volume's transform gizmo when one exists;
 * Ctrl and Shift clicks build a bulk selection in sidebar order. The gizmo seed is read before
 * queuing React state updates so a Ctrl click keeps the first selected volume.
 */
import type { Dispatch, SetStateAction } from 'react'
import { allowsSelectionPicking, RESTING_GIZMO_MODE, type GizmoMode } from '../editorGeometry'
import {
  addedPartHostId,
  effectiveAddedParts,
  instanceVolumeRows,
  type EditorInstance,
  type EditorState
} from './editorModel'
import {
  rangePartSelection,
  samePartMember,
  samePartRef,
  togglePartInSelection,
  type PartMember,
  type PartRef,
  type PartSelection
} from './selectionModel'

/** List body, baked, and session-added rows in the same order the sidebar renders them. */
export function ownerPartMembers(instance: EditorInstance, state: EditorState | null): PartMember[] {
  const added = effectiveAddedParts(state, instance)
  return [
    ...(instanceVolumeRows(instance, added.length).showBodyRow ? [{ kind: 'body' } as PartMember] : []),
    ...instance.parts.map((part): PartMember => ({ kind: 'baked', partIndex: part.partIndex })),
    ...added.map((part): PartMember => ({ kind: 'added', key: part.key }))
  ]
}

interface PartSelectionActionOptions {
  objectId: number
  member: PartMember
  modifiers: { additive: boolean; range: boolean }
  instanceKey: string
  keepTool?: boolean
  stateRef: { current: EditorState | null }
  gizmoPartRef: { current: PartRef | null }
  selectedKeyRef: { current: string | null }
  partAnchorRef: { current: PartRef | null }
  gizmoModeRef: { current: GizmoMode }
  selectExclusive: (key: string) => void
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setExtraSelectedKeys: Dispatch<SetStateAction<readonly string[]>>
  setPartSelection: Dispatch<SetStateAction<PartSelection | null>>
  setGizmoMode: Dispatch<SetStateAction<GizmoMode>>
}

/** Apply one sidebar part click to object, gizmo, and bulk-selection state. */
export function selectEditorPart(options: PartSelectionActionOptions): void {
  const { objectId, member, modifiers, instanceKey } = options
  if (!modifiers.additive && !modifiers.range) {
    const instance = options.stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((entry) => entry.key === instanceKey)
    // A body moves its object; an added part has its own mesh. Baked parts need per-part groups.
    const canTakeGizmo = member.kind === 'added'
      || member.kind === 'body'
      || (instance != null && (instance.source.kind === 'object' || instance.parts.length > 1))
    if (instance && canTakeGizmo) {
      if (samePartRef(options.gizmoPartRef.current, { objectId, member })
        && options.selectedKeyRef.current === instanceKey) {
        options.setGizmoPart(null)
        return
      }
      options.selectExclusive(instanceKey)
      options.setGizmoPart({ objectId, member })
      options.partAnchorRef.current = { objectId, member }
      if (!options.keepTool && !allowsSelectionPicking(options.gizmoModeRef.current)) {
        options.setGizmoMode(RESTING_GIZMO_MODE)
      }
      return
    }
  }

  // React resolves state updaters later; capture the gizmo before queuing its clear below.
  const gizmoSeed = options.gizmoPartRef.current
  options.setSelectedKey(null)
  options.setExtraSelectedKeys((current) => (current.length > 0 ? [] : current))
  options.setPartSelection((current) => {
    const seeded = current ?? (gizmoSeed && gizmoSeed.objectId === objectId
      ? { objectId, members: [gizmoSeed.member] }
      : current)
    if (modifiers.range) {
      const owner = options.stateRef.current?.plates.flatMap((plate) => plate.instances)
        .find((instance) => addedPartHostId(instance) === objectId)
      const ordered = owner ? ownerPartMembers(owner, options.stateRef.current) : [member]
      return rangePartSelection(objectId, ordered, options.partAnchorRef.current, member)
    }
    options.partAnchorRef.current = { objectId, member }
    if (modifiers.additive) return togglePartInSelection(seeded, objectId, member)
    if (seeded && seeded.objectId === objectId && seeded.members.length === 1
      && samePartMember(seeded.members[0]!, member)) {
      return null
    }
    return { objectId, members: [member] }
  })
  options.setGizmoPart((current) => (current ? null : current))
}
