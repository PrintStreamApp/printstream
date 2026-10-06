/**
 * Owns linked and independent object-copy actions in the editor. EditorView owns history, plate
 * synchronization, and the prompt host; this hook keeps copy identity, placement, and import
 * re-homing together. A pending clone passes its mesh source to the staging controller because
 * React may not have committed the clone to the live plate when staging begins.
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { toast } from '../../lib/toast'
import type { usePromptDialog } from '../../components/PromptDialogProvider'
import { addedPartHostId, duplicateInstance, findFreePlatePosition, instanceLinkageKey,
  makeInstanceIndependent, placeInstanceAt, type EditorPlate, type EditorState } from './lib/editorModel'
import type { createEditorIndependentCopyImports } from './lib/editorIndependentCopyImports'

/** BambuStudio's own upper limit for its number-of-copies prompt. */
const MAX_CLONE_COPIES = 1000

interface ObjectDuplicationOptions {
  activePlateIndex: number
  state: EditorState | null
  stateRef: { current: EditorState | null }
  selectionFor: (key: string) => string[]
  updatePlates: (updater: (plates: EditorPlate[]) => EditorPlate[]) => void
  selectExclusive: (key: string | null) => void
  independentCopyImports: ReturnType<typeof createEditorIndependentCopyImports>
  promptText: ReturnType<typeof usePromptDialog>['promptText']
  recordHistoryRef: { current: (() => void) | null }
  refreshAddedPartMeshes: () => void
  regenerateThumbnailRef: { current: (() => void) | null }
  setState: Dispatch<SetStateAction<EditorState | null>>
}

/** Return Duplicate, Clone, and Make independent actions for the current editor session. */
export function useEditorObjectDuplication(options: ObjectDuplicationOptions) {
  const {
    activePlateIndex, state, stateRef, selectionFor, updatePlates, selectExclusive,
    independentCopyImports, promptText, recordHistoryRef, refreshAddedPartMeshes,
    regenerateThumbnailRef, setState
  } = options
  const pendingMeshRestagesRef = useRef<Map<string, EditorState>>(new Map())

  useEffect(() => {
    for (const [key, sourceState] of pendingMeshRestagesRef.current) {
      if (state === sourceState) continue
      pendingMeshRestagesRef.current.delete(key)
      const live = state?.plates.some((plate) => plate.instances.some((instance) => instance.key === key))
      if (live) void independentCopyImports.restageMesh(key)
    }
  }, [independentCopyImports, state])

  /** Duplicate the current object selection as linked instances or independent objects. */
  const handleDuplicate = useCallback((key: string, independent = false, copies = 1) => {
    const keys = selectionFor(key)
    let cloneKey: string | null = null
    updatePlates((plates) => plates.map((plate) => {
      if (plate.index !== activePlateIndex) return plate
      let next = plate
      for (const target of keys) {
        const source = next.instances.find((entry) => entry.key === target)
        if (!source) continue
        for (let copy = 0; copy < copies; copy += 1) {
          const clone = duplicateInstance(source)
          if (independent && stateRef.current) {
            // A fresh import's identity lives in replacedObjectId, not objectId (which is 0).
            const sourceObjectId = addedPartHostId(clone)
            makeInstanceIndependent(stateRef.current, clone)
            const cloneObjectId = addedPartHostId(clone)
            if (sourceObjectId != null && cloneObjectId != null) {
              independentCopyImports.copyProcessOverrides(sourceObjectId, cloneObjectId)
            }
            if (cloneObjectId != null) void independentCopyImports.restageVolumes(cloneObjectId)
            // The clone is absent from stateRef during this updater. Its mesh starts staging only
            // after React commits it; a clone removed before that commit has nothing to re-home.
            if (clone.source.kind === 'import') {
              pendingMeshRestagesRef.current.set(clone.key, stateRef.current)
            }
          }
          // Search against the plate with earlier copies, so a batch does not stack them.
          const spot = findFreePlatePosition(next)
          placeInstanceAt(clone, spot.x, spot.y)
          cloneKey = clone.key
          next = { ...next, instances: [...next.instances, clone] }
        }
      }
      return next
    }))
    if (cloneKey) selectExclusive(cloneKey)
  }, [activePlateIndex, independentCopyImports, selectExclusive, selectionFor, stateRef, updatePlates])

  /** Prompt for BambuStudio's independent Clone count, then make that many copies. */
  const handleCloneWithCount = useCallback(async (key: string) => {
    const answer = await promptText({
      title: 'Clone',
      label: 'Number of copies',
      initialValue: '1',
      confirmLabel: 'Clone',
      validateValue: (value) => {
        const count = Number(value.trim())
        if (!Number.isInteger(count) || count < 1) return 'Enter a whole number of copies, 1 or more.'
        if (count > MAX_CLONE_COPIES) return `That is more than ${MAX_CLONE_COPIES} copies.`
        return null
      }
    })
    if (answer === null) return
    const count = Number(answer.trim())
    if (!Number.isInteger(count) || count < 1 || count > MAX_CLONE_COPIES) return
    handleDuplicate(key, true, count)
  }, [handleDuplicate, promptText])

  /** Count placed instances that still share this object's editable identity. */
  const linkedCopyCountFor = useCallback((key: string): number => {
    const instances = stateRef.current?.plates.flatMap((plate) => plate.instances) ?? []
    const instance = instances.find((entry) => entry.key === key)
    if (!instance) return 1
    const identity = instanceLinkageKey(instance)
    if (identity == null) return 1
    return instances.filter((entry) => instanceLinkageKey(entry) === identity).length
  }, [stateRef])

  /** Unlink a placed copy while retaining its current scene edits and geometry. */
  const handleMakeIndependent = useCallback((key: string) => {
    const state = stateRef.current
    const instance = state?.plates.flatMap((plate) => plate.instances).find((entry) => entry.key === key)
    if (!state || !instance) return
    const identity = instanceLinkageKey(instance)
    const shared = state.plates.flatMap((plate) => plate.instances)
      .filter((entry) => instanceLinkageKey(entry) === identity)
    if (identity == null || shared.length < 2) {
      toast.error('This model has no other copies, so it is already independent.')
      return
    }
    recordHistoryRef.current?.()
    const sourceObjectId = addedPartHostId(instance)
    makeInstanceIndependent(state, instance)
    const cloneObjectId = addedPartHostId(instance)
    if (sourceObjectId != null && cloneObjectId != null) {
      independentCopyImports.copyProcessOverrides(sourceObjectId, cloneObjectId)
    }
    if (cloneObjectId != null) void independentCopyImports.restageVolumes(cloneObjectId)
    void independentCopyImports.restageMesh(instance.key)
    refreshAddedPartMeshes()
    regenerateThumbnailRef.current?.()
    setState((current) => current ? { ...current } : current)
    toast.success('This copy is now independent: edits to it no longer affect the others.')
  }, [independentCopyImports, recordHistoryRef, refreshAddedPartMeshes,
    regenerateThumbnailRef, setState, stateRef])

  return { handleDuplicate, handleCloneWithCount, linkedCopyCountFor, handleMakeIndependent }
}
