/**
 * Owns material assignment across baked parts, whole objects, and session-added volumes.
 * Whole-object changes resolve linked identities before the plate update and change eligible
 * added volumes in the same history frame. Selected body, baked, and added rows use the shared
 * member dispatcher to preserve one Undo step across their separate stores.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { threeMfPartSubtypeCarriesFilament } from '@printstream/shared'
import {
  addedPartHostId,
  deriveObjectFilamentId,
  effectiveAddedParts,
  partSlotKey,
  type EditorPlate,
  type EditorState
} from './lib/editorModel'
import { changeEditorMemberFilament } from './lib/editorMemberChanges'
import { planInstanceFilamentAssignment } from './lib/editorInstanceFilamentAssignment'
import type { PartMember } from './lib/selectionModel'

type HistoryOption = { recordHistory?: boolean }
type BakedTarget = { objectId: number; partIndex: number }

interface MaterialAssignmentOptions {
  stateRef: MutableRefObject<EditorState | null>
  activePlateRef: MutableRefObject<EditorPlate | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  updatePlates: (
    updater: (plates: EditorPlate[]) => EditorPlate[],
    kind: 'material',
    options?: HistoryOption
  ) => void
  recordHistory: () => void
  recordHistoryRef: MutableRefObject<(() => void) | null>
  refreshAddedPartMeshes: () => void
  regenerateThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Return stable handlers for the editor's object, part, and selected-row material controls. */
export function useEditorMaterialAssignments(options: MaterialAssignmentOptions) {
  const {
    stateRef,
    activePlateRef,
    setState,
    updatePlates,
    recordHistory,
    recordHistoryRef,
    refreshAddedPartMeshes,
    regenerateThumbnailRef
  } = options

  /** Change material only on named session-added volumes, without assigning a helper. */
  const handleChangeAddedPartFilaments = useCallback((
    keys: ReadonlyArray<string>,
    filamentId: number,
    history?: HistoryOption
  ) => {
    const state = stateRef.current
    const wanted = new Set(keys)
    const parts = Object.values(state?.addedParts ?? {}).flat()
      .filter((part) => wanted.has(part.key)
        && threeMfPartSubtypeCarriesFilament(part.subtype)
        && part.filamentId !== filamentId)
    if (!state || parts.length === 0) return

    if (history?.recordHistory !== false) recordHistoryRef.current?.()
    for (const part of parts) part.filamentId = filamentId
    refreshAddedPartMeshes()
    regenerateThumbnailRef.current?.()
    // The session map changes in place; a new state identity updates the sidebar rows.
    setState((current) => current ? { ...current } : current)
  }, [recordHistoryRef, refreshAddedPartMeshes, regenerateThumbnailRef, setState, stateRef])

  /** Change a baked part by ordinal across every linked copy of its object. */
  const reassignFilament = useCallback((
    targets: BakedTarget[],
    filamentId: number,
    history?: HistoryOption
  ) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => partSlotKey(target.objectId, target.partIndex)))
    updatePlates((plates) => plates.map((plate) => ({
      ...plate,
      instances: plate.instances.map((instance) => {
        // An unsaved import uses its replacement id until the next bake creates a real object id.
        const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
        if (ownerId == null) return instance

        let changed = false
        const parts = instance.parts.map((part) => {
          if (!targetSet.has(partSlotKey(ownerId, part.partIndex))
            || !threeMfPartSubtypeCarriesFilament(part.subtype)) return part
          changed = true
          return { ...part, filamentId }
        })
        if (!changed) return instance

        // The object fallback for unassigned imported parts must not erase another part's choice.
        return { ...instance, parts, filamentId: deriveObjectFilamentId(parts, instance.filamentId) }
      })
    })), 'material', { recordHistory: history?.recordHistory })
  }, [updatePlates])

  /** Change a whole object's material, including linked copies and its printable added volumes. */
  const reassignInstanceFilament = useCallback((
    keys: readonly string[],
    filamentId: number,
    assignmentOptions?: { includeVolumes?: boolean; recordHistory?: boolean }
  ) => {
    const assignment = planInstanceFilamentAssignment(stateRef.current, keys, filamentId, assignmentOptions)
    if (!assignment) return
    updatePlates(assignment.mapPlates, 'material', { recordHistory: assignmentOptions?.recordHistory })
    // The plate update or selected-member dispatcher has already checkpointed this gesture.
    if (assignment.addedPartKeys.length > 0) {
      handleChangeAddedPartFilaments(assignment.addedPartKeys, filamentId, { recordHistory: false })
    }
  }, [handleChangeAddedPartFilaments, stateRef, updatePlates])

  /** A part selection offers material when at least one selected volume can carry it. */
  const partsAcceptFilament = useCallback((objectId: number, members: ReadonlyArray<PartMember>) => {
    if (members.some((member) => member.kind === 'body')) return true
    const ids = new Set(members.flatMap((member) => member.kind === 'baked' ? [member.partIndex] : []))
    const keys = new Set(members.flatMap((member) => member.kind === 'added' ? [member.key] : []))
    for (const instance of activePlateRef.current?.instances ?? []) {
      if (addedPartHostId(instance) !== objectId) continue
      if (instance.parts.some((part) => ids.has(part.partIndex)
        && threeMfPartSubtypeCarriesFilament(part.subtype))) return true
      if (effectiveAddedParts(stateRef.current, instance).some((part) => keys.has(part.key)
        && threeMfPartSubtypeCarriesFilament(part.subtype))) return true
    }
    return false
  }, [activePlateRef, stateRef])

  /** Route selected body, baked, and added rows through one history checkpoint. */
  const handleChangeMemberFilament = useCallback((
    objectId: number,
    members: ReadonlyArray<PartMember>,
    filamentId: number
  ) => {
    changeEditorMemberFilament({
      objectId,
      members,
      filamentId,
      state: stateRef.current,
      recordHistory,
      changeBody: reassignInstanceFilament,
      changeBaked: reassignFilament,
      changeAdded: handleChangeAddedPartFilaments
    })
  }, [handleChangeAddedPartFilaments, reassignFilament, reassignInstanceFilament,
    recordHistory, stateRef])

  return {
    handleChangeAddedPartFilaments,
    reassignFilament,
    reassignInstanceFilament,
    partsAcceptFilament,
    handleChangeMemberFilament
  }
}
