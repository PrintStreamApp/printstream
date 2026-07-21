/**
 * Undo/redo + unsaved-edit tracking for the 3MF project editor.
 *
 * Thin React wrapper over the framework-free {@link EditorHistoryModel}: it owns the
 * scene-restore side effects (cloning, setState, slice-config restore) and mirrors the
 * model's flags into React state so the toolbar/Save button re-render. It also wraps
 * the slice controller's structural edits — printer target, nozzle, plate type, material
 * add/remove — so those route through the same undo/redo as scene edits. Pulled out of
 * EditorView so the component body keeps to scene wiring and rendering.
 *
 * The slice config lives in the host `SliceFileModal`, not in the editor's scene state, so
 * it is snapshotted through the controller's `configSnapshot`/`restoreConfig` pair rather
 * than cloned here. A user gesture must reach this wrapper as ONE call: the controller
 * exposes combined actions (`selectPrinter`, `selectPrinterModel`) for the picks that would
 * otherwise be two setter calls, because two calls would push two history frames and cost
 * two Ctrl+Z to reverse one action.
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
  /** Snapshot the current slice configuration before a settings mutation begins. */
  recordSliceConfigHistory: () => void
  /** Slice controller wrapped so settings edits record an undo checkpoint first. */
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

  // Slice-settings edits live in the slice controller; refs keep undo/redo reading the latest
  // snapshot/restore without re-creating those callbacks on every controller render.
  const configSnapshotRef = useRef(sliceConfig?.configSnapshot)
  configSnapshotRef.current = sliceConfig?.configSnapshot
  const restoreConfigRef = useRef(sliceConfig?.restoreConfig)
  restoreConfigRef.current = sliceConfig?.restoreConfig

  // Material profile/colour edits are not snapshotted for undo, so they stay dirty until
  // save (sticky), unlike scene edits which clear when fully undone.
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
  // button greys again with no post-save re-lighting. Still needed alongside `dirty` even
  // though a printer pick is now a recorded checkpoint: a project with no source machine
  // (a new-project scaffold) gets its target SEEDED rather than picked, so nothing records.
  const hasUnsavedChanges = dirty || sliceConfig?.retargetTarget != null

  /** Snapshot the current scene before a scene mutation begins. */
  const recordHistory = useCallback(() => {
    const current = stateRef.current
    if (!current) return
    modelRef.current!.record({ state: cloneEditorState(current), sliceConfig: null })
    syncFlags()
  }, [syncFlags, stateRef])
  const recordHistoryRef = useRef(recordHistory)
  recordHistoryRef.current = recordHistory

  /** Snapshot the current slice configuration before a settings mutation begins. */
  const recordSliceConfigHistory = useCallback(() => {
    const snapshot = configSnapshotRef.current
    const model = modelRef.current!
    // No snapshot to capture (e.g. the slice config not loaded): the edit still happened, but
    // it can't be undone, so fall back to a sticky non-undoable dirty mark.
    if (!snapshot) {
      model.markNonUndoableDirty()
      syncFlags()
      return
    }
    model.record({ state: null, sliceConfig: snapshot })
    syncFlags()
  }, [syncFlags])

  // Global process-setting edits (profile switch + the process-settings dialog, both rendered by
  // the host slice modal) call this BEFORE mutating the controller. Snapshot the current material
  // state — which now carries processProfileId/processSettingOverrides — so the edit is undoable
  // and lights Save. Mirrors the material-picker listener (markSettingsDirty) above.
  useEffect(() => {
    const ref = sliceConfig?.processEditListenerRef
    if (!ref) return
    ref.current = recordSliceConfigHistory
    return () => { ref.current = null }
  }, [sliceConfig, recordSliceConfigHistory])

  const restoreHistoryState = useCallback((target: EditorState) => {
    const restored = cloneEditorState(target)
    setSelectedKey((current) => (current && restored.plates.some((plate) => plate.instances.some((instance) => instance.key === current)) ? current : null))
    setActivePlateIndex((index) => (restored.plates.some((plate) => plate.index === index) ? index : (restored.plates[0]?.index ?? 1)))
    setState(restored)
    setRebuildToken((token) => token + 1)
  }, [setSelectedKey, setActivePlateIndex, setState, setRebuildToken])

  // Apply one history entry, returning the inverse entry for the opposite stack.
  const applyHistoryEntry = useCallback((entry: EditorHistoryEntry): EditorHistoryEntry => {
    const inverse: EditorHistoryEntry = { state: null, sliceConfig: null }
    if (entry.state) {
      const current = stateRef.current
      inverse.state = current ? cloneEditorState(current) : null
      restoreHistoryState(entry.state)
    }
    if (entry.sliceConfig) {
      inverse.sliceConfig = configSnapshotRef.current ?? null
      restoreConfigRef.current?.(entry.sliceConfig)
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

  // The settings panel calls the controller's setters directly; wrap the ones that change the
  // saved project so each records an undo checkpoint first, routing settings edits through the
  // same undo/redo as scene edits (Ctrl+Z / the toolbar buttons).
  //
  // Every wrapped setter here must correspond to ONE user gesture. The printer picks arrive as
  // the controller's combined `selectPrinter`/`selectPrinterModel` actions for exactly that
  // reason — wrapping the underlying id/mode/touched setters separately would record a frame
  // each and take two undos to reverse one pick.
  //
  // Changing the printer target also re-derives state the editor owns: the scene queries are
  // keyed on the target model, so each plate's bed and unprintable zones are rewritten when the
  // new target's scenes arrive (see the resync effect in EditorView). That rewrite is NOT
  // recorded, and must not be — it is derived, so undoing back to the previous target restores
  // the previous bed on its own from the cached scene.
  const sliceConfigForPanel = useMemo<SliceSettingsController | undefined>(() => {
    if (!sliceConfig) return undefined
    return {
      ...sliceConfig,
      // Printer target. A model switch re-resolves the process and filament presets, so the
      // snapshot these record deliberately spans the whole slice config, not just the target.
      selectPrinter: (printer) => { recordSliceConfigHistory(); sliceConfig.selectPrinter(printer) },
      selectPrinterModel: (model) => { recordSliceConfigHistory(); sliceConfig.selectPrinterModel(model) },
      setSelectedSlicerTargetId: (value) => { recordSliceConfigHistory(); sliceConfig.setSelectedSlicerTargetId(value) },
      setNozzleDiameter: (value) => { recordSliceConfigHistory(); sliceConfig.setNozzleDiameter(value) },
      setNozzleFlow: (value) => { recordSliceConfigHistory(); sliceConfig.setNozzleFlow(value) },
      onAddFilament: () => { recordSliceConfigHistory(); sliceConfig.onAddFilament() },
      // BambuStudio parity: only an OBJECT reference blocks removal — reassign the object first.
      // A material referenced solely by a process setting (support / support interface, infill or
      // wall filament) is removable: BambuStudio drops the setting back to "Default" instead of
      // refusing, and the controller does the same, remapping the surviving references to their
      // new positions (`lib/filamentIndexOverrides.ts`). Blocking on those instead stranded a
      // material that could not be deleted until the project was saved and reopened, because the
      // support set is seeded from the LAST SAVED index and a cleared override never removes it.
      filamentInUse: (projectFilamentId: number) =>
        usedFilamentIds.has(projectFilamentId) && !supportOnlyFilamentIds.has(projectFilamentId),
      filamentSupportOnly: (projectFilamentId: number) => supportOnlyFilamentIds.has(projectFilamentId),
      onRemoveFilament: (projectFilamentId: number) => {
        if (usedFilamentIds.has(projectFilamentId) && !supportOnlyFilamentIds.has(projectFilamentId)) {
          toast.error('This material is used by one or more objects. Reassign them to another material before removing it.')
          return
        }
        recordSliceConfigHistory()
        sliceConfig.onRemoveFilament(projectFilamentId)
      },
      // The plate type feeds the plates' `plateType` (written as `curr_bed_type`) into the saved
      // 3MF and is part of the config snapshot, so it undoes like the rest of the target.
      setPlateType: (value) => { recordSliceConfigHistory(); sliceConfig.setPlateType(value) },
      // Material profile/colour edits feed `desiredFilaments` into the saved 3MF, so they count as
      // unsaved changes. They are applied through the controller's own picker Modal rather than
      // this wrapper (see materialEditListenerRef), so a checkpoint recorded here would capture
      // the wrong moment — they only flip the sticky dirty flag for the Save button.
      handleMaterialOptionChange: (projectFilamentId, option) => { markSettingsDirty(); sliceConfig.handleMaterialOptionChange(projectFilamentId, option) },
      setFilamentColors: (value) => { markSettingsDirty(); sliceConfig.setFilamentColors(value) },
      setFilamentToolheadIds: (value) => { markSettingsDirty(); sliceConfig.setFilamentToolheadIds(value) }
    }
  }, [sliceConfig, recordSliceConfigHistory, markSettingsDirty, usedFilamentIds, supportOnlyFilamentIds])

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
    recordSliceConfigHistory,
    sliceConfigForPanel
  }
}
