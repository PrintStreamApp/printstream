/**
 * Owns removal of selected body, baked, and session-added volumes. The same printable-geometry
 * guard drives menu availability and the actual action, including keyboard Delete. A mixed
 * deletion records one history frame before either storage seam changes.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react'
import { canonicalThreeMfPartSubtype, isNonRenderableThreeMfPartSubtype } from '@printstream/shared'
import { addedPartHostId, bodyPartSubtype, canRemoveParts, effectiveAddedParts,
  withRemovedParts, type EditorState } from './lib/editorModel'
import type { PartMember, PartRef, PartSelection } from './lib/selectionModel'

interface PartRemovalOptions {
  stateRef: { current: EditorState | null }
  recordHistory: () => void
  setState: Dispatch<SetStateAction<EditorState | null>>
  setGizmoPart: Dispatch<SetStateAction<PartRef | null>>
  setPartSelection: Dispatch<SetStateAction<PartSelection | null>>
  setRebuildToken: Dispatch<SetStateAction<number>>
  refreshAddedPartMeshes: () => void
  regenerateThumbnailRef: { current: (() => void) | null }
}

/** Return the shared removal gate and the guarded action for editor part selections. */
export function useEditorPartRemoval(options: PartRemovalOptions) {
  const {
    stateRef, recordHistory, setState, setGizmoPart, setPartSelection,
    setRebuildToken, refreshAddedPartMeshes, regenerateThumbnailRef
  } = options

  /**
   * A part deletion must leave printed geometry. In particular, an added volume may be the last
   * printable part after the object's original body is removed; deleting it would make the object
   * vanish in the viewport and could restore that deleted body when the project is saved.
   */
  const partSelectionRemovable = useCallback((objectId: number, members: ReadonlyArray<PartMember>) => {
    const instance = stateRef.current?.plates.flatMap((plate) => plate.instances)
      .find((entry) => addedPartHostId(entry) === objectId)
    if (!instance) return false

    const goingKeys = new Set(members.flatMap((member) => member.kind === 'added' ? [member.key] : []))
    const bakedIndexes = new Set(members.flatMap((member) => member.kind === 'baked' ? [member.partIndex] : []))
    const survivingVolumes = effectiveAddedParts(stateRef.current, instance)
      .filter((part) => !goingKeys.has(part.key)
        && !isNonRenderableThreeMfPartSubtype(canonicalThreeMfPartSubtype(part.subtype)))
      .length
    // A single-mesh body has no baked part row. Count it only if this gesture keeps it.
    const bodySurvives = instance.parts.length === 0
      && !instance.bodyRemoved
      && !members.some((member) => member.kind === 'body')
      && !isNonRenderableThreeMfPartSubtype(bodyPartSubtype(stateRef.current, instance))
    return canRemoveParts(instance, bakedIndexes, survivingVolumes + (bodySurvives ? 1 : 0))
  }, [stateRef])

  /** Remove one selection through both part stores and release selections that named it. */
  const handleRemoveParts = useCallback((hostId: number, members: ReadonlyArray<PartMember>) => {
    if (members.length === 0 || !partSelectionRemovable(hostId, members)) return
    const state = stateRef.current
    if (!state) return
    recordHistory()

    const addedKeys = new Set(members.flatMap((member) => member.kind === 'added' ? [member.key] : []))
    if (addedKeys.size > 0 && state.addedParts) {
      // Drop added volumes before asking withRemovedParts whether any printed geometry survives.
      for (const [objectId, parts] of Object.entries(state.addedParts)) {
        const next = parts.filter((part) => !addedKeys.has(part.key))
        if (next.length !== parts.length) state.addedParts[Number(objectId)] = next
      }
      refreshAddedPartMeshes()
    }

    const bakedIndexes = new Set(members.flatMap((member) => member.kind === 'baked' ? [member.partIndex] : []))
    if (bakedIndexes.size > 0) {
      setState((current) => current ? withRemovedParts(current, hostId, bakedIndexes) ?? current : current)
    } else if (addedKeys.size > 0) {
      // The addedParts map is mutated in place; refresh identity for the sidebar.
      setState((current) => current ? { ...current } : current)
    }

    if (members.some((member) => member.kind === 'body')) {
      setState((current) => current ? {
        ...current,
        plates: current.plates.map((plate) => ({
          ...plate,
          instances: plate.instances.map((item) => addedPartHostId(item) === hostId
            ? { ...item, bodyRemoved: true }
            : item)
        }))
      } : current)
    }

    setPartSelection(null)
    setGizmoPart(null)
    setRebuildToken((token) => token + 1)
    regenerateThumbnailRef.current?.()
  }, [partSelectionRemovable, recordHistory, refreshAddedPartMeshes,
    regenerateThumbnailRef, setGizmoPart, setPartSelection, setRebuildToken, setState, stateRef])

  return { partSelectionRemovable, handleRemoveParts }
}
