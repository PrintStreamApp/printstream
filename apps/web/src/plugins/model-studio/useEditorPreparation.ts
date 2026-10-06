/**
 * Owns the editor's save/slice preparation dialog lifecycle. Persistence remains
 * in useEditorSave and slice authoring remains in editorSlicePreparation; this
 * hook coordinates their progress, cancellation, retries, and host handoff.
 * A slice uses the opened archive's thumbnails; refreshing every plate is save
 * work and would delay a slice without changing its print input.
 * The finalizing ref closes the cancellation window before React paints it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { SceneEdit } from '@printstream/shared'
import type { ChunkedLibraryUploadProgress } from '../../lib/chunkedLibraryUpload'
import type { EditorPreparationDialog, SavePreparationPhase, SlicePreparationPhase } from './EditorPreparationDialog'
import { editorPreparationDialogState } from './lib/editorPreparationPresentation'
import { observeSavePreparation, retryEditorPreparationStatus, stopEditorPreparationStatusCheck } from './lib/editorPreparation'
import { createEditorSavePreparation, type SavePreparationRetry } from './lib/editorSavePreparation'
import { cancelEditorSlicePreparation, startEditorSlicePreparation, type EditorSliceRequest } from './lib/editorSlicePreparation'
import type { EditorState } from './lib/editorModel'
import type { EditorSave } from './useEditorSave'

interface EditorPreparationOptions {
  stateRef: MutableRefObject<EditorState | null>
  save: Pick<EditorSave, 'saving' | 'savedFile' | 'contentBase' | 'stageSnapshotFor' | 'handleSaveVersion' | 'handleSaveAs'>
  slicingProp: boolean
  onSlice?: (request: EditorSliceRequest) => void | Promise<void>
  buildSceneEdit: (state: EditorState) => SceneEdit
  authorFilamentConfigs: (edit: SceneEdit, options: { signal: AbortSignal }) => Promise<SceneEdit>
}

/** Coordinate the two preparation flows and expose their single dialog state. */
export function useEditorPreparation({
  stateRef,
  save,
  slicingProp,
  onSlice,
  buildSceneEdit,
  authorFilamentConfigs
}: EditorPreparationOptions) {
  const {
    saving,
    savedFile,
    contentBase,
    stageSnapshotFor,
    handleSaveVersion,
    handleSaveAs
  } = save
  const [preparingSlice, setPreparingSlice] = useState(false)
  const [slicePreparationError, setSlicePreparationError] = useState<string | null>(null)
  const [slicePreparationPhase, setSlicePreparationPhase] = useState<SlicePreparationPhase>('collecting')
  const [preparingSave, setPreparingSave] = useState(false)
  const [savePreparationPhase, setSavePreparationPhase] = useState<SavePreparationPhase>('checking')
  const [savePreparationError, setSavePreparationError] = useState<string | null>(null)
  const [transferProgress, setTransferProgress] = useState<ChunkedLibraryUploadProgress | null>(null)
  const [savePreparationFinalizing, setSavePreparationFinalizing] = useState(false)
  const [savePreparationReconciling, setSavePreparationReconciling] = useState(false)
  const [preparationRecoveryMessage, setPreparationRecoveryMessage] = useState<string | null>(null)

  const savePreparationFinalizingRef = useRef(false)
  const savePreparationErrorRef = useRef<string | null>(null)
  const savePreparationRetryRef = useRef<SavePreparationRetry | null>(null)
  const savePreparationObservedBusyRef = useRef(false)
  const slicePreparationAbortRef = useRef<AbortController | null>(null)
  const lastSlicePlateRef = useRef(0)
  const savePreparationAbortRef = useRef<AbortController | null>(null)
  const preparationRecoveryRetryRef = useRef<(() => void) | null>(null)
  const preparationRecoveryStopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => {
    slicePreparationAbortRef.current?.abort()
    savePreparationAbortRef.current?.abort()
  }, [])

  const slicing = slicingProp || preparingSlice
  useEffect(() => {
    if (slicingProp) {
      setSlicePreparationError(null)
      setTransferProgress(null)
      preparationRecoveryRetryRef.current = null
      preparationRecoveryStopRef.current = null
      setPreparationRecoveryMessage(null)
      setPreparingSlice(false)
    }
  }, [slicingProp])

  useEffect(() => {
    // The wrapper and useEditorSave update separately. Observe a busy save before interpreting a
    // later idle render as completion; accepted paths release saving in finally, including failures.
    const next = observeSavePreparation(preparingSave, saving, savePreparationObservedBusyRef.current)
    savePreparationObservedBusyRef.current = next.observedBusy
    if (next.close) {
      savePreparationAbortRef.current = null
      savePreparationFinalizingRef.current = false
      setTransferProgress(null)
      preparationRecoveryRetryRef.current = null
      preparationRecoveryStopRef.current = null
      setPreparationRecoveryMessage(null)
      if (!savePreparationErrorRef.current) {
        savePreparationRetryRef.current = null
        setPreparingSave(false)
      }
    }
  }, [preparingSave, saving])

  const savePreparation = useMemo(() => createEditorSavePreparation({
    abortRef: savePreparationAbortRef,
    retryRef: savePreparationRetryRef,
    errorRef: savePreparationErrorRef,
    finalizingRef: savePreparationFinalizingRef,
    recoveryRetryRef: preparationRecoveryRetryRef,
    recoveryStopRef: preparationRecoveryStopRef,
    setPreparing: setPreparingSave,
    setPhase: setSavePreparationPhase,
    setError: setSavePreparationError,
    setFinalizing: setSavePreparationFinalizing,
    setReconciling: setSavePreparationReconciling,
    setRecoveryMessage: setPreparationRecoveryMessage,
    setProgress: setTransferProgress
  }), [])

  const startSaveVersion = useCallback(() => {
    handleSaveVersion(savePreparation.begin({ kind: 'version' }, 'checking'))
  }, [handleSaveVersion, savePreparation])
  const startSaveAs = useCallback((name: string, destinationFolderId: string | null) => {
    const retry: SavePreparationRetry = { kind: 'saveAs', name, destinationFolderId }
    handleSaveAs(name, destinationFolderId, savePreparation.begin(retry, 'creating'))
  }, [handleSaveAs, savePreparation])
  const startSlice = useCallback((plate: number) => {
    void startEditorSlicePreparation(plate, {
      stateRef,
      abortRef: slicePreparationAbortRef,
      lastPlateRef: lastSlicePlateRef,
      recoveryRetryRef: preparationRecoveryRetryRef,
      recoveryStopRef: preparationRecoveryStopRef,
      onSlice,
      contentBase,
      sourceFile: savedFile?.libraryFile,
      buildSceneEdit,
      authorFilamentConfigs,
      makeStageSnapshot: (sceneEdit, callbacks) => (target, slicerTargetId, signal) => stageSnapshotFor(
        sceneEdit,
        target,
        slicerTargetId,
        signal,
        callbacks.onPhase,
        callbacks.onProgress,
        callbacks.onReconciliationStart,
        callbacks.onReconciliationRequired
      ),
      setError: setSlicePreparationError,
      setPhase: setSlicePreparationPhase,
      setRecoveryMessage: setPreparationRecoveryMessage,
      setProgress: setTransferProgress,
      setPreparing: setPreparingSlice
    })
  }, [onSlice, buildSceneEdit, authorFilamentConfigs, stateRef, contentBase,
    savedFile, stageSnapshotFor])

  const retryPreparationStatus = useCallback(() => {
    retryEditorPreparationStatus({
      retryRef: preparationRecoveryRetryRef,
      stopRef: preparationRecoveryStopRef,
      preparingSave,
      setRecoveryMessage: setPreparationRecoveryMessage,
      setSaveReconciling: setSavePreparationReconciling,
      setSlicePhase: setSlicePreparationPhase
    })
  }, [preparingSave])
  const stopCheckingPreparation = useCallback(() => {
    stopEditorPreparationStatusCheck({
      retryRef: preparationRecoveryRetryRef,
      stopRef: preparationRecoveryStopRef
    })
  }, [])
  const retrySavePreparation = useCallback(() => {
    const retry = savePreparationRetryRef.current
    if (!retry) return
    if (retry.kind === 'version') startSaveVersion()
    else startSaveAs(retry.name, retry.destinationFolderId)
  }, [startSaveAs, startSaveVersion])
  const cancelEditorPreparation = useCallback(() => {
    if (slicePreparationError) {
      setSlicePreparationError(null)
      return
    }
    if (savePreparationError) {
      savePreparation.dismissError()
      return
    }
    if (preparingSlice && !slicingProp) {
      cancelEditorSlicePreparation({
        abortRef: slicePreparationAbortRef,
        recoveryRetryRef: preparationRecoveryRetryRef,
        recoveryStopRef: preparationRecoveryStopRef,
        setRecoveryMessage: setPreparationRecoveryMessage,
        setProgress: setTransferProgress,
        setPreparing: setPreparingSlice
      })
      return
    }
    if (preparingSave) savePreparation.cancelPending()
  }, [preparingSave, preparingSlice, savePreparationError, slicePreparationError, slicingProp, savePreparation])

  const dialogState = editorPreparationDialogState({
    slicePreparationError,
    preparingSlice,
    slicing: slicingProp,
    savePreparationError,
    preparingSave,
    recoveryMessage: preparationRecoveryMessage,
    savePreparationReconciling,
    slicePreparationPhase
  })
  let retryPreparation: (() => void) | undefined
  if (slicePreparationError) {
    retryPreparation = () => { startSlice(lastSlicePlateRef.current) }
  } else if (savePreparationError) {
    retryPreparation = retrySavePreparation
  }

  return {
    slicing,
    dialogProps: {
      action: dialogState.action,
      savePhase: savePreparationPhase,
      slicePhase: dialogState.slicePhase,
      finalizing: savePreparationFinalizing,
      transferProgress,
      recoveryMessage: preparationRecoveryMessage,
      error: slicePreparationError ?? savePreparationError,
      onCancel: cancelEditorPreparation,
      onRetry: retryPreparation,
      onRetryStatus: retryPreparationStatus,
      onStopWaiting: stopCheckingPreparation
    } satisfies Parameters<typeof EditorPreparationDialog>[0],
    startSaveVersion,
    startSaveAs,
    startSlice
  }
}
