/**
 * Short-lived metadata for the next printer-observed job start.
 *
 * App-initiated starts reserve a durable print-job id before the printer
 * reports `job.started`. The recorder consumes this metadata when the
 * printer manager later observes the real transition and links it back to
 * the same tracked job row.
 */
import type { PrintStartOptionSelection } from '@printstream/shared'

export interface PendingPrintJobSource {
  jobKind: 'file' | 'calibration' | 'external'
  jobId: string | null
  taskId?: string | null
  printerFilePath?: string | null
  fileId: string | null
  fileName: string | null
  fileSizeBytes: number | null
  sourceKind: '3mf' | 'gcode' | null
  /**
   * Re-slice provenance for the printed artifact: the preserved project 3MF it was
   * sliced from and the settings that produced it. Optional because only the library
   * dispatch path knows them: calibration and externally-observed starts never do.
   */
  sourceProjectFileId?: string | null
  sliceSettingsJson?: string | null
  plate: number | null
  useAms: boolean | null
  /**
   * Legacy bed-leveling record: the tri-state choice collapsed to a Boolean, so 'on' and
   * 'auto' are indistinguishable here. Still written for the jobs DTO and for older readers;
   * `printOptions` is what a re-print restores from.
   */
  bedLevel: boolean | null
  amsMapping: number[] | null
  /**
   * The print-start options the user SELECTED, recorded so re-printing this job repeats them.
   * Optional because only app-initiated prints have them: an externally started print's
   * options were chosen on the printer or in Studio and are never reported to us.
   */
  printOptions?: PrintStartOptionSelection | null
  calibrationOption: number | null
}

const PENDING_SOURCE_TTL_MS = 10 * 60_000
const pendingSources = new Map<string, { metadata: PendingPrintJobSource; expiresAt: number }>()

export function registerPendingPrintJobSource(printerId: string, metadata: PendingPrintJobSource): void {
  prunePendingPrintJobSources()
  pendingSources.set(printerId, {
    metadata,
    expiresAt: Date.now() + PENDING_SOURCE_TTL_MS
  })
}

export function consumePendingPrintJobSource(printerId: string): PendingPrintJobSource | null {
  prunePendingPrintJobSources()
  const entry = pendingSources.get(printerId)
  if (!entry) return null
  pendingSources.delete(printerId)
  return entry.metadata
}

export function peekPendingPrintJobSource(printerId: string): PendingPrintJobSource | null {
  prunePendingPrintJobSources()
  return pendingSources.get(printerId)?.metadata ?? null
}

export function clearPendingPrintJobSource(printerId: string): void {
  pendingSources.delete(printerId)
}

export function clearAllPendingPrintJobSources(): void {
  pendingSources.clear()
}

function prunePendingPrintJobSources(): void {
  const now = Date.now()
  for (const [printerId, entry] of pendingSources.entries()) {
    if (entry.expiresAt <= now) pendingSources.delete(printerId)
  }
}