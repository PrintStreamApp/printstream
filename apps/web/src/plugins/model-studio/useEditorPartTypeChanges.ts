/**
 * Owns Bambu part-type changes across baked parts and session-added volumes. Baked changes update
 * every linked instance and persist part ordinals for the next bake; added changes mutate their
 * session map and refresh live meshes. The selected-member dispatcher records one history frame
 * when a gesture spans both stores.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { threeMfPartSubtypeCarriesFilament, type SceneEditPartSubtype } from '@printstream/shared'
import { partSlotKey, type EditorState } from './lib/editorModel'

type PartTarget = { objectId: number; partIndex: number }
type HistoryOption = { recordHistory?: boolean }

interface PartTypeChangeOptions {
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  setRebuildToken: Dispatch<SetStateAction<number>>
  recordHistory: () => void
  recordHistoryRef: MutableRefObject<(() => void) | null>
  refreshAddedPartMeshes: () => void
  regenerateThumbnailRef: MutableRefObject<(() => void) | null>
}

/** Return the baked, added, and stable single-part type-change actions. */
export function useEditorPartTypeChanges(options: PartTypeChangeOptions) {
  const {
    stateRef, setState, setRebuildToken, recordHistory, recordHistoryRef,
    refreshAddedPartMeshes, regenerateThumbnailRef
  } = options

  /** Re-type baked parts on every linked instance and record their original ordinals for saving. */
  const handleChangePartTypes = useCallback((
    targets: ReadonlyArray<PartTarget>,
    subtype: SceneEditPartSubtype,
    history?: HistoryOption
  ) => {
    if (targets.length === 0) return
    const targetSet = new Set(targets.map((target) => partSlotKey(target.objectId, target.partIndex)))
    if (history?.recordHistory !== false) recordHistory()
    setState((current) => {
      if (!current) return current
      const plates = current.plates.map((plate) => ({
        ...plate,
        instances: plate.instances.map((instance) => {
          // A saved part keys on objectId; an imported part uses its synthetic replacement id.
          const ownerId = instance.source.kind === 'object' ? instance.objectId : instance.source.replacedObjectId
          if (ownerId == null || !instance.parts.some((part) => targetSet.has(partSlotKey(ownerId, part.partIndex)))) {
            return instance
          }
          // A helper has no material. Drop the old id rather than hiding it so a later save does
          // not restore stale extruder metadata when the user retypes it again.
          const keepsFilament = threeMfPartSubtypeCarriesFilament(subtype)
          return {
            ...instance,
            parts: instance.parts.map((part) => targetSet.has(partSlotKey(ownerId, part.partIndex))
              ? { ...part, subtype, ...(keepsFilament ? {} : { filamentId: null, color: null }) }
              : part)
          }
        })
      }))
      const partTypeChanges = { ...(current.partTypeChanges ?? {}) }
      for (const target of targets) partTypeChanges[partSlotKey(target.objectId, target.partIndex)] = subtype
      return { ...current, plates, partTypeChanges }
    })
    setRebuildToken((token) => token + 1)
  }, [recordHistory, setRebuildToken, setState])

  /** Keep the memoized sidebar's single-row callback stable between unrelated renders. */
  const handleChangeOnePartType = useCallback((
    objectId: number,
    partIndex: number,
    subtype: SceneEditPartSubtype
  ) => handleChangePartTypes([{ objectId, partIndex }], subtype), [handleChangePartTypes])

  /** Re-type session-added volumes and refresh their rendered shape and sidebar identity. */
  const handleChangeAddedPartTypes = useCallback((
    keys: ReadonlyArray<string>,
    subtype: SceneEditPartSubtype,
    history?: HistoryOption
  ) => {
    const state = stateRef.current
    const wanted = new Set(keys)
    const parts = Object.values(state?.addedParts ?? {}).flat()
      .filter((entry) => wanted.has(entry.key) && entry.subtype !== subtype)
    if (!state || parts.length === 0) return
    if (history?.recordHistory !== false) recordHistoryRef.current?.()
    for (const part of parts) {
      part.subtype = subtype
      if (!threeMfPartSubtypeCarriesFilament(subtype)) part.filamentId = null
    }
    refreshAddedPartMeshes()
    regenerateThumbnailRef.current?.()
    // addedParts is mutated in place; a new state identity updates the sidebar rows.
    setState((current) => current ? { ...current } : current)
  }, [recordHistoryRef, refreshAddedPartMeshes, regenerateThumbnailRef, setState, stateRef])

  return { handleChangePartTypes, handleChangeOnePartType, handleChangeAddedPartTypes }
}
