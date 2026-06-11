/**
 * Printer-card media buffering helpers.
 *
 * These rules preserve the last successful thumbnail/frame while a refreshed
 * asset is loading so live status updates do not flash back to placeholders.
 */
export function resolveBufferedCoverUrl(input: {
  currentCoverUrl: string | null
  previousCoverRequestUrl: string | null
  nextCoverRequestUrl: string | null
}): string | null {
  const { currentCoverUrl, previousCoverRequestUrl, nextCoverRequestUrl } = input
  if (!nextCoverRequestUrl) return null
  return previousCoverRequestUrl === nextCoverRequestUrl ? currentCoverUrl : null
}

export function resolveBufferedSnapshotSrc(input: {
  previousPrinterId: string
  printerId: string
  currentDisplaySrc: string | null
  cachedSnapshotSrc: string | null
}): string | null {
  const { previousPrinterId, printerId, currentDisplaySrc, cachedSnapshotSrc } = input

  if (previousPrinterId !== printerId) {
    return cachedSnapshotSrc
  }

  return cachedSnapshotSrc ?? currentDisplaySrc
}