/**
 * Owns the shared progress-dialog lifecycle for Save version and Save As.
 * `useEditorSave` performs the actual persistence; this controller resets dialog state before
 * either operation and carries commit/reconciliation callbacks that must behave identically.
 */
import type { ChunkedLibraryUploadProgress } from '../../../lib/chunkedLibraryUpload'
import type { SavePreparationPhase } from '../EditorPreparationDialog'
import type { EditorPersistenceLifecycle } from './editorSaveTarget'

export type SavePreparationRetry =
  | { kind: 'version' }
  | { kind: 'saveAs'; name: string; destinationFolderId: string | null }

type Ref<T> = { current: T }

interface SavePreparationOptions {
  abortRef: Ref<AbortController | null>
  retryRef: Ref<SavePreparationRetry | null>
  errorRef: Ref<string | null>
  finalizingRef: Ref<boolean>
  recoveryRetryRef: Ref<(() => void) | null>
  recoveryStopRef: Ref<(() => void) | null>
  setPreparing: (value: boolean) => void
  setPhase: (value: SavePreparationPhase) => void
  setError: (value: string | null) => void
  setFinalizing: (value: boolean) => void
  setReconciling: (value: boolean) => void
  setRecoveryMessage: (value: string | null) => void
  setProgress: (value: ChunkedLibraryUploadProgress | null) => void
}

/** Create lifecycle callbacks whose refs remain live across either save operation. */
export function createEditorSavePreparation(options: SavePreparationOptions) {
  const {
    abortRef,
    retryRef,
    errorRef,
    finalizingRef,
    recoveryRetryRef,
    recoveryStopRef,
    setPreparing,
    setPhase,
    setError,
    setFinalizing,
    setReconciling,
    setRecoveryMessage,
    setProgress
  } = options

  return {
    /** Abort an older attempt, reset the dialog, and return hooks for the new save. */
    begin(retry: SavePreparationRetry, phase: SavePreparationPhase): EditorPersistenceLifecycle {
      abortRef.current?.abort()
      const abort = new AbortController()
      abortRef.current = abort
      setPreparing(true)
      retryRef.current = retry
      errorRef.current = null
      setError(null)
      setPhase(phase)
      finalizingRef.current = false
      setFinalizing(false)
      setReconciling(false)
      recoveryRetryRef.current = null
      recoveryStopRef.current = null
      setRecoveryMessage(null)
      setProgress(null)

      return {
        signal: abort.signal,
        onLocalPhase: setPhase,
        onProgress: setProgress,
        onCommitStart: () => {
          // The ref closes the one-event window before React paints finalizing=true.
          finalizingRef.current = true
          setFinalizing(true)
        },
        onReconciliationStart: (stopWaiting) => {
          finalizingRef.current = true
          recoveryStopRef.current = stopWaiting
          setReconciling(true)
        },
        onReconciliationRequired: (retryStatus, message, stopWaiting) => {
          finalizingRef.current = true
          recoveryRetryRef.current = retryStatus
          recoveryStopRef.current = stopWaiting
          setRecoveryMessage(message)
          setReconciling(false)
        },
        onError: (message) => {
          errorRef.current = message
          setError(message)
        }
      }
    },

    /** Close an error dialog and drop the saved retry request. */
    dismissError(): void {
      errorRef.current = null
      retryRef.current = null
      setError(null)
      setPreparing(false)
    },

    /** Abort before commit starts; return false once cancellation is no longer safe. */
    cancelPending(): boolean {
      if (finalizingRef.current) return false
      abortRef.current?.abort()
      abortRef.current = null
      retryRef.current = null
      setPreparing(false)
      return true
    }
  }
}
