/**
 * Coordinates editor preparation dialog transitions shared by save and slice.
 * Recovery callbacks are consumed before invocation so repeated clicks cannot retry or stop
 * the same reconciliation poll twice; the save busy observer waits for a real busy transition.
 */
import type { ModelFetchProgress } from './modelFetch'
import type { SlicePreparationPhase } from '../EditorPreparationDialog'

interface PreparationRecoveryRefs {
  retryRef: { current: (() => void) | null }
  stopRef: { current: (() => void) | null }
}

/** Retry status reconciliation once, marking the active save or slice dialog as checking. */
export function retryEditorPreparationStatus(options: PreparationRecoveryRefs & {
  preparingSave: boolean
  setRecoveryMessage: (message: string | null) => void
  setSaveReconciling: (value: boolean) => void
  setSlicePhase: (phase: SlicePreparationPhase) => void
}): void {
  const retry = options.retryRef.current
  if (!retry) return

  options.retryRef.current = null
  options.stopRef.current = null
  options.setRecoveryMessage(null)
  if (options.preparingSave) options.setSaveReconciling(true)
  else options.setSlicePhase('reconciling')
  retry()
}

/** Consume the pending stop callback so a second click cannot stop the same poll twice. */
export function stopEditorPreparationStatusCheck(options: PreparationRecoveryRefs): void {
  const stop = options.stopRef.current
  if (!stop) return

  options.retryRef.current = null
  options.stopRef.current = null
  stop()
}

/** Keep the dialog open through the render before the save hook's busy state becomes observable. */
export function observeSavePreparation(
  preparing: boolean,
  saving: boolean,
  observedBusy: boolean
): { observedBusy: boolean; close: boolean } {
  if (!preparing) return { observedBusy: false, close: false }
  if (saving) return { observedBusy: true, close: false }
  return { observedBusy, close: observedBusy }
}

/**
 * Limit transfer-driven React updates while preserving the exact start and finish.
 *
 * Browser streams commonly deliver one 64 KiB chunk at a time. Publishing every chunk into the
 * editor's root state makes a large project rerender hundreds of times during one download, while
 * the shared progress bar already animates between much slower updates.
 */
export function createDownloadProgressReporter(
  report: (progress: ModelFetchProgress) => void,
  minimumIntervalMs = 100,
  now: () => number = () => performance.now()
): (progress: ModelFetchProgress) => void {
  let lastReportedAt = Number.NEGATIVE_INFINITY
  return (progress) => {
    const atBoundary = progress.loadedBytes === 0 || (
      progress.totalBytes != null && progress.loadedBytes >= progress.totalBytes
    )
    const currentTime = now()
    if (!atBoundary && currentTime - lastReportedAt < minimumIntervalMs) return
    lastReportedAt = currentTime
    report(progress)
  }
}
