/**
 * Short-lived metadata for the next printer-observed job start.
 *
 * App-initiated starts reserve a durable print-job id before the printer
 * reports `job.started`. The recorder consumes this metadata when the
 * printer manager later observes the real transition and links it back to
 * the same tracked job row.
 */
export interface PendingPrintJobSource {
  jobKind: 'file' | 'calibration' | 'external'
  jobId: string | null
  taskId?: string | null
  printerFilePath?: string | null
  fileId: string | null
  fileName: string | null
  fileSizeBytes: number | null
  sourceKind: '3mf' | 'gcode' | null
  plate: number | null
  useAms: boolean | null
  bedLevel: boolean | null
  amsMapping: number[] | null
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