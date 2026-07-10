/**
 * Undo/redo + unsaved-edit tracking for the 3MF project editor.
 *
 * Thin React wrapper over the framework-free {@link EditorHistoryModel}: it owns the
 * scene-restore side effects (cloning, setState, material restore) and mirrors the
 * model's flags into React state so the toolbar/Save button re-render. It also wraps
 * the slice controller's material add/remove so those edits route through the same
 * undo/redo as scene edits. Pulled out of EditorView so the component body keeps to
 * scene wiring and rendering.
 *
 * Dirtiness rules live in EditorHistoryModel: undoable edits clear when fully undone;
 * non-undoable material profile/colour edits stay dirty until save. The component
 * calls `markSaved()` once a save succeeds.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from '../../lib/toast'
import { type SliceSettingsController } from '../../components/library/SliceSettingsPanel'
import { cloneEditorState, type EditorState } from './lib/editorModel'
import { type EditorHistoryEntry } from './editorGeometry'
import { EditorHistoryModel } from './editorHistoryModel'

/** Max retained undo steps. */
const HISTORY_LIMIT = 100

export interface EditorHistoryParams {
  /** Live pointer to the current editable state (mutated outside React by gizmo drags). */
  stateRef: MutableRefObject<EditorState | null>
  setState: Dispatch<SetStateAction<EditorState | null>>
  setSelectedKey: Dispatch<SetStateAction<string | null>>
  setActivePlateIndex: Dispatch<SetStateAction<number>>
  /** Bumped on restore to force a plate re-render; owned by the caller (shared with other mutations). */
  setRebuildToken: Dispatch<SetStateAction<number>>
  sliceConfig: SliceSettingsController | undefined
  /** Live set of materials any object/part/layer/paint OR support setting references (remove-guard). */
  usedFilamentIds: Set<number>
  /** Subset of {@link usedFilamentIds} used ONLY for supports — drives the accurate remove-blocked copy. */
  supportOnlyFilamentIds: Set<number>
}

export interface EditorHistory {
  /** Live mirror of whether the project has unsaved edits (read by the close guard). */
  dirtyRef: MutableRefObject<boolean>
  /** Adopt the current state as the saved baseline (call after a successful save). */
  markSaved: () => void
  /** `isDirty` OR a pending cross-model retarget (both count as unsaved work). */
  hasUnsavedChanges: boolean
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void
  undoRef: MutableRefObject<() => void>
  redoRef: MutableRefObject<() => void>
  /** Snapshot the current scene before a scene mutation begins. */
  recordHistory: () => void
  recordHistoryRef: MutableRefObject<() => void>
  /** Snapshot the current material set before a material add/remove begins. */
  recordMaterialsHistory: () => void
  /** Slice controller wrapped so material add/remove records an undo checkpoint first. */
  sliceConfigForPanel: SliceSettingsController | undefined
}

export function useEditorHistory({
  stateRef,
  setState,
  setSelectedKey,
  setActivePlateIndex,
  setRebuildToken,
  sliceConfig,
  usedFilamentIds,
  supportOnlyFilamentIds
}: EditorHistoryParams): EditorHistory {
  // useRef (not useMemo) so the undo stacks persist for the editor's lifetime — a
  // useMemo value may be discarded and recreated by React, which would drop history.
  const modelRef = useRef<EditorHistoryModel | null>(null)
  modelRef.current ??= new EditorHistoryModel(HISTORY_LIMIT)

  // True once the project has unsaved edits; mirrors the model so the close guard (a ref
  // read) and the Save button (reactive state) both see the latest value.
  const dirtyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  // Push the model's flags into refs/state after any operation that changes them.
  const syncFlags = useCallback(() => {
    const model = modelRef.current!
    dirtyRef.current = model.isDirty
    setDirty(model.isDirty)
    setCanUndo(model.canUndo)
    setCanRedo(model.canRedo)
  }, [])

  // Warn on page refresh / navigation away while there are unsaved edits (the in-app
  // close already warns via handleCloseRequest; this covers the browser-level exit).
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Material edits live in the slice controller; refs keep undo/redo reading the latest
  // snapshot/restore without re-creating those callbacks on every controller render.
  const materialsSnapshotRef = useRef(sliceConfig?.materialsSnapshot)
  materialsSnapshotRef.current = sliceConfig?.materialsSnapshot
  const restoreMaterialsRef = useRef(sliceConfig?.restoreMaterials)
  restoreMaterialsRef.current = sliceConfig?.restoreMaterials

  // Material profile/colour/nozzle and plate-type edits are not snapshotted for undo, so they
  // stay dirty until save (sticky), unlike scene edits which clear when fully undone.
  const markSettingsDirty = useCallback(() => {
    modelRef.current!.markNonUndoableDirty()
    syncFlags()
  }, [syncFlags])

  // The "Choose material" picker Modal is rendered by the host slice dialog (which stays mounted
  // behind the editor), so a pick there calls the controller's raw `handleMaterialOptionChange` and
  // bypasses the markSettingsDirty-wrapped copy below. Register it as the controller's material-edit
  // listener so those picks still light the Save button.
  useEffect(() => {
    const ref = sliceConfig?.materialEditListenerRef
    if (!ref) return
    ref.current = markSettingsDirty
    return () => { ref.current = null }
  }, [sliceConfig, markSettingsDirty])
  // A pending cross-model retarget (selected machine differs from the project's source) is
  // itself unsaved work, so it enables Save. Derived, not a marked flag: once saved, the
  // project's source model matches the target and `retargetTarget` clears on its own — the
  // button greys again with no post-save re-lighting.
  const hasUnsavedChanges = dirty || sliceConfig?.retargetTarget != null

  /** Snapshot the current scene before a scene mutation begins. */
  const recordHistory = useCallback(() => {
    const current = stateRef.current
    if (!current) return
    modelRef.current!.record({ state: cloneEditorState(current), materials: null })
    syncFlags()
  }, [syncFlags, stateRef])
  const recordHistoryRef = useRef(recordHistory)
  recordHistoryRef.current = recordHistory

  /** Snapshot the current material set before a material add/remove begins. */
  const recordMaterialsHistory = useCallback(() => {
    const snapshot = materialsSnapshotRef.current
    const model = modelRef.current!
    // No snapshot to capture (e.g. materials not loaded): the edit still happened, but it
    // can't be undone, so fall back to a sticky non-undoable dirty mark.
    if (!snapshot) {
      model.markNonUndoableDirty()
      syncFlags()
      return
    }
    model.record({ state: null, materials: snapshot })
    syncFlags()
  }, [syncFlags])

  const restoreHistoryState = useCallback((target: EditorState) => {
    const restored = cloneEditorState(target)
    setSelectedKey((current) => (current && restored.plates.some((plate) => plate.instances.some((instance) => instance.key === current)) ? current : null))
    setActivePlateIndex((index) => (restored.plates.some((plate) => plate.index === index) ? index : (restored.plates[0]?.index ?? 1)))
    setState(restored)
    setRebuildToken((token) => token + 1)
  }, [setSelectedKey, setActivePlateIndex, setState, setRebuildToken])

  // Apply one history entry, returning the inverse entry for the opposite stack.
  const applyHistoryEntry = useCallback((entry: EditorHistoryEntry): EditorHistoryEntry => {
    const inverse: EditorHistoryEntry = { state: null, materials: null }
    if (entry.state) {
      const current = stateRef.current
      inverse.state = current ? cloneEditorState(current) : null
      restoreHistoryState(entry.state)
    }
    if (entry.materials) {
      inverse.materials = materialsSnapshotRef.current ?? null
      restoreMaterialsRef.current?.(entry.materials)
    }
    return inverse
  }, [restoreHistoryState, stateRef])

  const undo = useCallback(() => {
    if (modelRef.current!.undo(applyHistoryEntry)) syncFlags()
  }, [applyHistoryEntry, syncFlags])

  const redo = useCallback(() => {
    if (modelRef.current!.redo(applyHistoryEntry)) syncFlags()
  }, [applyHistoryEntry, syncFlags])
  const undoRef = useRef(undo)
  undoRef.current = undo
  const redoRef = useRef(redo)
  redoRef.current = redo

  const markSaved = useCallback(() => {
    modelRef.current!.markSaved()
    syncFlags()
  }, [syncFlags])

  // The settings panel calls the controller's material add/remove directly; wrap them so
  // each records an undo checkpoint first (routing material edits through the same
  // undo/redo as scene edits — Ctrl+Z / the toolbar buttons).
  const sliceConfigForPanel = useMemo<SliceSettingsController | undefined>(() => {
    if (!sliceConfig) return undefined
    return {
      ...sliceConfig,
      onAddFilament: () => { recordMaterialsHistory(); sliceConfig.onAddFilament() },
      // BambuStudio parity: a material that's still referenced can't be removed — reassign first.
      // `filamentSupportOnly` flags the materials used ONLY for supports so the UI can word the
      // block accurately ("used for supports" vs "used by an object").
      filamentInUse: (projectFilamentId: number) => usedFilamentIds.has(projectFilamentId),
      filamentSupportOnly: (projectFilamentId: number) => supportOnlyFilamentIds.has(projectFilamentId),
      onRemoveFilament: (projectFilamentId: number) => {
        if (usedFilamentIds.has(projectFilamentId)) {
          toast.error(supportOnlyFilamentIds.has(projectFilamentId)
            ? 'This material is used for supports. Change the support filament before removing it.'
            : 'This material is used by one or more objects. Reassign them to another material before removing it.')
          return
        }
        recordMaterialsHistory()
        sliceConfig.onRemoveFilament(projectFilamentId)
      },
      // Material profile/colour/nozzle edits feed `desiredFilaments` — and the plate type feeds
      // the plates' `plateType` (written as `curr_bed_type`) — into the saved 3MF, so they count
      // as unsaved changes; they are not snapshotted for undo (the controller owns that), so
      // they only need to flip the sticky dirty flag for the Save button.
      handleMaterialOptionChange: (projectFilamentId, option) => { markSettingsDirty(); sliceConfig.handleMaterialOptionChange(projectFilamentId, option) },
      setFilamentColors: (value) => { markSettingsDirty(); sliceConfig.setFilamentColors(value) },
      setFilamentToolheadIds: (value) => { markSettingsDirty(); sliceConfig.setFilamentToolheadIds(value) },
      setPlateType: (value) => { markSettingsDirty(); sliceConfig.setPlateType(value) }
    }
  }, [sliceConfig, recordMaterialsHistory, markSettingsDirty, usedFilamentIds, supportOnlyFilamentIds])

  return {
    dirtyRef,
    markSaved,
    hasUnsavedChanges,
    canUndo,
    canRedo,
    undo,
    redo,
    undoRef,
    redoRef,
    recordHistory,
    recordHistoryRef,
    recordMaterialsHistory,
    sliceConfigForPanel
  }
}
