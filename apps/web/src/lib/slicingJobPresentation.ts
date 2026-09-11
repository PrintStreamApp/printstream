import { getSlicingJobStatusLabel, type SlicingJob, type SlicingMetadata } from '@printstream/shared'
import { formatLibraryFileName } from './libraryDisplay'
import { formatSecondsDuration } from './time'
import { formatFilamentCost } from './filamentCost'

// Status classification/labels and the history-result mapping moved to @printstream/shared
// (`slicing.ts` / `job-history.ts`) so the server-side job-history search filters on the same
// text these cards render; re-exported so the web's import sites keep one path.
export { getSlicingJobStatusLabel, isActiveSlicingJob, slicingHistoryResult } from '@printstream/shared'

export interface SlicingProgressFrame {
  message: string
  totalPercent: number | null
}

/** The engine's own progress, parsed from the JSON frames it writes to stdout. */
export function getLatestSlicingProgressFrame(job: SlicingJob): SlicingProgressFrame | null {
  let latestFrame: SlicingProgressFrame | null = null

  for (const line of job.output) {
    const text = line?.text?.trim()
    if (!text) continue
    const frame = parseSlicingProgressFrame(text)
    if (frame) latestFrame = frame
  }

  return latestFrame
}

/**
 * The determinate percentage is meaningful only while the slicing engine owns the job.
 * Its final frame remains at 100% while the API saves the result, whose duration is not
 * measurable by that frame and must therefore render as indeterminate progress.
 */
export function getSlicingProgressPercent(
  job: SlicingJob,
  progressFrame: SlicingProgressFrame | null
): number | null {
  if (job.status !== 'slicing') return null
  return getLatestSlicingActivity(job)?.kind === 'engine'
    ? progressFrame?.totalPercent ?? null
    : null
}

export function formatSlicingProgress(job: SlicingJob, progressFrame: SlicingProgressFrame | null): string {
  // The engine's own progress belongs to a RUNNING slice only. Its last frame survives in the
  // output after the job ends, and rendering it left a finished slice reading "Exporting 3mf
  // (97%)" next to a "Ready" chip. A finished job reports its outcome instead, which `finish()`
  // wrote as the job's final system line ("Slicing complete", "Sliced file saved to the library").
  if (job.status === 'slicing') {
    const activity = getLatestSlicingActivity(job)
    if (activity?.kind === 'system') return activity.message
    if (activity?.kind === 'engine' && progressFrame) {
      if (progressFrame.totalPercent == null) return progressFrame.message
      return `${progressFrame.message} (${Math.round(progressFrame.totalPercent)}%)`
    }
  }

  // Before the engine emits a frame, the API's own status lines are all there is to show.
  const latestSystemLine = getLatestSystemOutputLine(job)
  if (latestSystemLine) return latestSystemLine

  if (job.status === 'ready' && job.outputFileName) return `Saved as ${formatLibraryFileName(job.outputFileName)}`
  if (job.status === 'queued') return getSlicingJobStatusLabel(job)
  if (job.status === 'preparing') return 'Starting the slice...'
  if (job.status === 'slicing' || job.status === 'saving') return 'Slicing...'
  if (job.status === 'cancelled') return 'Slicing cancelled'
  if (job.status === 'failed') return job.error ?? 'Slicing failed'
  return job.sourceFileName
}

export function formatSlicingMetadataDisplay(metadata: SlicingMetadata | undefined): string {
  if (!metadata) return ''

  const parts: string[] = []
  if (metadata.estimatedPrintTimeSeconds != null && metadata.estimatedPrintTimeSeconds >= 60) {
    // Shared formatter rolls >24h estimates into days (e.g. `1d 6h`).
    parts.push(formatSecondsDuration(metadata.estimatedPrintTimeSeconds))
  }

  if (metadata.estimatedFilamentWeightGrams != null) {
    parts.push(`${metadata.estimatedFilamentWeightGrams.toFixed(1)}g`)
  }

  if (metadata.estimatedFilamentCost != null) {
    parts.push(formatFilamentCost(metadata.estimatedFilamentCost))
  }

  return parts.length > 0 ? parts.join(' • ') : ''
}

export function slicingStatusColor(status: SlicingJob['status']): 'neutral' | 'primary' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'queued': return 'neutral'
    case 'preparing':
    case 'slicing':
    case 'saving': return 'primary'
    case 'ready': return 'success'
    case 'cancelled': return 'warning'
    case 'failed': return 'danger'
  }
}

function getLatestSystemOutputLine(job: SlicingJob): string | null {
  for (let index = job.output.length - 1; index >= 0; index -= 1) {
    const line = job.output[index]
    if (line?.stream !== 'system') continue
    const text = line.text.trim()
    if (text) return text
  }
  return null
}

/** The last user-facing phase emitted by either the engine or its surrounding pipeline. */
function getLatestSlicingActivity(job: SlicingJob):
  | { kind: 'engine'; frame: SlicingProgressFrame }
  | { kind: 'system'; message: string }
  | null {
  for (let index = job.output.length - 1; index >= 0; index -= 1) {
    const line = job.output[index]
    if (!line) continue
    const text = line.text.trim()
    if (!text) continue
    if (line.stream === 'system') return { kind: 'system', message: text }
    const frame = parseSlicingProgressFrame(text)
    if (frame) return { kind: 'engine', frame }
  }
  return null
}

function parseSlicingProgressFrame(value: string): Pick<SlicingProgressFrame, 'message' | 'totalPercent'> | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const message = firstNonEmptyString(parsed.message, parsed.status)
    if (!message) return null
    const totalPercent = normalizeProgressPercent(firstFiniteNumber(parsed.total_percent, parsed.totalPercent, parsed.percent))
    return { message, totalPercent }
  } catch {
    return null
  }
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function normalizeProgressPercent(value: number | null): number | null {
  if (value == null) return null
  return Math.max(0, Math.min(100, value))
}
