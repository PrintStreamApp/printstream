import type { ModelFetchProgress } from './modelFetch'

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
