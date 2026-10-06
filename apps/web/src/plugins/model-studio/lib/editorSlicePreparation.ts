/**
 * Owns the editor's pre-slice dialog and handoff to its host. The host freezes the target before
 * calling the staged-snapshot closure; this module keeps the authored scene tied to that closure.
 * Superseded and canceled attempts must never clear or update the current attempt's dialog.
 */
import type { LibraryFile, SceneEdit, SlicingTarget } from '@printstream/shared'
import { extractErrorMessage } from '@printstream/shared'
import { afterNextPaint } from '../../../lib/afterNextPaint'
import type { ChunkedLibraryUploadProgress } from '../../../lib/chunkedLibraryUpload'
import type { SlicePreparationPhase } from '../EditorPreparationDialog'
import type { EditorContentBasePin } from './contentBasePin'
import type { EditorState } from './editorModel'

export interface EditorSliceRequest {
  plate: number
  sceneEdit: SceneEdit
  contentBase: EditorContentBasePin | null
  sourceFile?: LibraryFile
  stageSnapshot: (
    target: SlicingTarget,
    slicerTargetId: string | null,
    signal?: AbortSignal
  ) => Promise<string | Uint8Array | null>
  signal: AbortSignal
}

export interface SliceStageCallbacks {
  onPhase: (phase: 'applying' | 'uploading' | 'finalizing' | 'reconciling') => void
  onProgress: (progress: ChunkedLibraryUploadProgress) => void
  onReconciliationStart: (stopWaiting: () => void) => void
  onReconciliationRequired: (retry: () => void, message: string, stopWaiting: () => void) => void
}

interface SlicePreparationOptions {
  stateRef: { current: EditorState | null }
  abortRef: { current: AbortController | null }
  lastPlateRef: { current: number }
  recoveryRetryRef: { current: (() => void) | null }
  recoveryStopRef: { current: (() => void) | null }
  onSlice?: (request: EditorSliceRequest) => void | Promise<void>
  contentBase: EditorContentBasePin | null
  sourceFile?: LibraryFile
  buildSceneEdit: (state: EditorState) => SceneEdit
  authorFilamentConfigs: (edit: SceneEdit, options: { signal: AbortSignal }) => Promise<SceneEdit>
  makeStageSnapshot: (edit: SceneEdit, callbacks: SliceStageCallbacks) => EditorSliceRequest['stageSnapshot']
  setError: (message: string | null) => void
  setPhase: (phase: SlicePreparationPhase) => void
  setRecoveryMessage: (message: string | null) => void
  setProgress: (progress: ChunkedLibraryUploadProgress | null) => void
  setPreparing: (value: boolean) => void
  waitForPaint?: () => Promise<void>
  reportError?: (error: unknown) => void
}

interface CancelSlicePreparationOptions {
  abortRef: { current: AbortController | null }
  recoveryRetryRef: { current: (() => void) | null }
  recoveryStopRef: { current: (() => void) | null }
  setRecoveryMessage: (message: string | null) => void
  setProgress: (progress: ChunkedLibraryUploadProgress | null) => void
  setPreparing: (value: boolean) => void
}

/** Stop a pre-handoff slice attempt and clear its dialog state and recovery callbacks. */
export function cancelEditorSlicePreparation(options: CancelSlicePreparationOptions): void {
  options.recoveryStopRef.current?.()
  options.recoveryStopRef.current = null
  options.recoveryRetryRef.current = null
  options.abortRef.current?.abort()
  options.abortRef.current = null
  options.setRecoveryMessage(null)
  options.setProgress(null)
  options.setPreparing(false)
}

/** Start a preparation attempt, or do nothing when the scene or host callback is absent. */
export function startEditorSlicePreparation(
  plate: number,
  options: SlicePreparationOptions
): Promise<void> | null {
  const current = options.stateRef.current
  const onSlice = options.onSlice
  if (!current || !onSlice) return null
  const initialState: EditorState = current
  const hostSlice: (request: EditorSliceRequest) => void | Promise<void> = onSlice

  options.abortRef.current?.abort()
  const abort = new AbortController()
  options.abortRef.current = abort
  options.lastPlateRef.current = plate
  options.setError(null)
  options.setPhase('collecting')
  options.recoveryRetryRef.current = null
  options.recoveryStopRef.current = null
  options.setRecoveryMessage(null)
  options.setProgress(null)
  options.setPreparing(true)

  const isCurrent = () => options.abortRef.current === abort
  const callbacks: SliceStageCallbacks = {
    onPhase: (phase) => { if (isCurrent()) options.setPhase(phase) },
    onProgress: (progress) => { if (isCurrent()) options.setProgress(progress) },
    onReconciliationStart: (stopWaiting) => {
      if (!isCurrent()) return
      options.recoveryStopRef.current = stopWaiting
      options.setPhase('reconciling')
    },
    onReconciliationRequired: (retry, message, stopWaiting) => {
      if (!isCurrent()) return
      options.recoveryRetryRef.current = retry
      options.recoveryStopRef.current = stopWaiting
      options.setRecoveryMessage(message)
      options.setPhase('recovery-required')
    }
  }

  return run()

  async function run(): Promise<void> {
    try {
      await (options.waitForPaint ?? afterNextPaint)()
      abort.signal.throwIfAborted()
      const sceneEdit = await options.authorFilamentConfigs(options.buildSceneEdit(initialState), {
        signal: abort.signal
      })
      abort.signal.throwIfAborted()

      await hostSlice({
        plate,
        sceneEdit,
        contentBase: options.contentBase,
        ...(options.sourceFile ? { sourceFile: options.sourceFile } : {}),
        stageSnapshot: options.makeStageSnapshot(sceneEdit, callbacks),
        signal: abort.signal
      })
      // A cached result starts no create-job mutation, so the host may never clear this flag.
      if (isCurrent()) {
        options.setPreparing(false)
        options.setProgress(null)
      }
    } catch (error) {
      if (!isCurrent()) return
      options.setPreparing(false)
      options.setProgress(null)
      if (error instanceof Error && error.name === 'AbortError') return
      // A rejected async handoff has no caller to catch it; log it and show the dialog error.
      (options.reportError ?? ((failure) => console.error('[editor] preparing the slice failed', failure)))(error)
      options.setError(extractErrorMessage(error, 'Could not prepare the slice.'))
    } finally {
      if (isCurrent()) options.abortRef.current = null
    }
  }
}
