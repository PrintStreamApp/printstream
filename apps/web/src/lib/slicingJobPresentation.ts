import type { PrintJob, SlicingJob, SlicingMetadata } from '@printstream/shared'
import { formatLibraryFileName } from './libraryDisplay'
import { formatSecondsDuration } from './time'

export interface SlicingProgressFrame {
  message: string
  totalPercent: number | null
  displayPercent: number | null
  stageIndex: number
  totalStages: number
}

const MACHINE_SWITCH_STAGE_START = 'Normalizing project with upstream machine-switch export'
const MACHINE_SWITCH_STAGE_SLICE = 'Slicing normalized project'

export function isActiveSlicingJob(job: SlicingJob): boolean {
  return job.status === 'queued' || job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving'
}

export function getSlicingJobStatusLabel(job: SlicingJob): string {
  if (job.status === 'queued' && job.queuePosition) return `Queued #${job.queuePosition}`
  switch (job.status) {
    case 'queued': return 'Queued'
    case 'preparing': return 'Preparing'
    case 'slicing': return 'Slicing'
    case 'saving': return 'Saving'
    case 'ready': return 'Ready'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

export function getLatestSlicingProgressFrame(job: SlicingJob): SlicingProgressFrame | null {
  let latestFrame: SlicingProgressFrame | null = null
  let totalStages = 1
  let stageIndex = 1

  for (const line of job.output) {
    const text = line?.text?.trim()
    if (!text) continue

    if (line.stream === 'system') {
      if (text === MACHINE_SWITCH_STAGE_START) {
        totalStages = 2
        stageIndex = 1
      } else if (text === MACHINE_SWITCH_STAGE_SLICE) {
        totalStages = 2
        stageIndex = 2
      }
    }

    const frame = parseSlicingProgressFrame(text)
    if (!frame) continue

    latestFrame = {
      ...frame,
      stageIndex,
      totalStages,
      displayPercent: resolveDisplayPercent(stageIndex, totalStages, frame.totalPercent)
    }
  }

  return latestFrame
}

export function formatSlicingProgress(job: SlicingJob, progressFrame: SlicingProgressFrame | null): string {
  if (progressFrame) {
    const stagePrefix = progressFrame.totalStages > 1 ? `Stage ${progressFrame.stageIndex} of ${progressFrame.totalStages}: ` : ''
    if (progressFrame.totalPercent == null) return `${stagePrefix}${progressFrame.message}`
    return `${stagePrefix}${progressFrame.message} (${Math.round(progressFrame.totalPercent)}%)`
  }

  const latestSystemLine = getLatestSystemOutputLine(job)
  const explicitStageStatus = formatExplicitStageStatus(job, latestSystemLine)
  if (explicitStageStatus) return explicitStageStatus
  if (latestSystemLine) return latestSystemLine

  if (job.status === 'ready' && job.outputFileName) return `Saved as ${formatLibraryFileName(job.outputFileName)}`
  if (job.status === 'queued') return getSlicingJobStatusLabel(job)
  if (job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving') return 'Slicer is still processing...'
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
    parts.push(`$${metadata.estimatedFilamentCost.toFixed(2)}`)
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

export function slicingHistoryResult(job: SlicingJob): PrintJob['result'] {
  switch (job.status) {
    case 'ready': return 'success'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    default: return 'unknown'
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

function resolveDisplayPercent(stageIndex: number, totalStages: number, totalPercent: number | null): number | null {
  if (totalPercent == null) return null
  if (totalStages <= 1) return totalPercent
  const aggregatePercent = ((stageIndex - 1) + (totalPercent / 100)) / totalStages * 100
  return normalizeProgressPercent(aggregatePercent)
}

function formatExplicitStageStatus(job: SlicingJob, latestSystemLine: string | null): string | null {
  if (job.status !== 'preparing' && job.status !== 'slicing') return null
  if (latestSystemLine === MACHINE_SWITCH_STAGE_START) return 'Stage 1 of 2: Normalizing project'
  if (latestSystemLine === MACHINE_SWITCH_STAGE_SLICE) return 'Stage 2 of 2: Slicing normalized project'
  return null
}