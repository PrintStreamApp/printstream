/**
 * Persists printer-observed job lifecycle events.
 *
 * The printer manager is the source of truth for when a job actually starts
 * and finishes. The dispatcher can add optional PrintStream metadata (library
 * file, plate, AMS mapping) for jobs it initiated so history rows can support
 * rich display and reprint preselection.
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PendingPrintJobSource } from './pending-print-job-source.js'
import { buildPlateGcodeFileHint, inferObservedPrintPlateIndex, normalizeFallbackPlateLabel, type PrinterStatus } from '@printstream/shared'
import { persistHistoryThumbnailFromLibrary } from './job-history-thumbnail-source.js'
import { printerEvents } from './printer-events.js'
import { printerManager } from './printer-manager.js'
import { rootPrisma } from './prisma.js'
import { isMissingColumnError } from './prisma-errors.js'
import { ensurePrintJobSnapshot } from './print-job-snapshots.js'
import { readLibraryThreeMfPlateUsage } from './library-three-mf.js'
import { resolvePrinterCoverPath } from './printer-cover-source.js'
import { recordFinishedPrinterStats } from './printer-stats.js'
import { readPrinterStorageThreeMfIndex } from './printer-storage-3mf.js'
import { broadcastJobsChanged } from './ws-resource-events.js'
import { normalizeActivePrintTaskId } from './active-print-task.js'
import { isMetadataPlateGcodePath, normalizeExactPrinterFilePath } from './printer-file-path.js'
import {
  assignPendingDispatchedPrintSourceTask,
  clearDispatchedPrintSource,
  clearPendingDispatchedPrintSource,
  reassignDispatchedPrintSourceTask
} from './dispatched-print-source-cache.js'
import { clearPendingPrintJobSource, peekPendingPrintJobSource, registerPendingPrintJobSource } from './pending-print-job-source.js'
import { visibleLibraryFilesWhere } from './library-visibility.js'

let printJobSnapshotEnsurer: typeof ensurePrintJobSnapshot = ensurePrintJobSnapshot

const activeJobs = new Map<string, string>()
const activeJobTaskIds = new Map<string, string | null>()
const activeJobPrinterFilePaths = new Map<string, string | null>()
const externalJobActivations = new Map<string, Promise<string | null>>()
const pendingTrackedJobActivations = new Map<string, Promise<string | null>>()
const trackedStartGraceUntil = new Map<string, number>()
const delayedThumbnailPersists = new Set<ReturnType<typeof setTimeout>>()
const PRINT_JOB_THUMBNAIL_PERSIST_DELAY_MS = 10_000
const TRACKED_START_GRACE_MS = 60_000
let started = false

interface PrintJobStartRecord {
  id: string
  jobName: string
}

interface UnfinishedPrintJobRow {
  id: string
  printerId: string
  taskId: string | null
  jobName: string
  printerFilePath: string | null
  sourceType: string
  fileId: string | null
  thumbnailPath: string | null
  startedAt: Date
}

interface ObservedLibraryFileMatch {
  id: string
  name: string
  storedPath: string
  sizeBytes: number
  kind: string
}

function emitRecordedJobStarted(event: { jobId: string; printerId: string; jobName: string }): void {
  const printer = printerManager.getPrinter(event.printerId)
  if (!printer) return
  printerEvents.emit('print-job.started', {
    jobId: event.jobId,
    printer,
    jobName: event.jobName
  })
}

function emitRecordedJobFinished(event: {
  jobId: string
  printerId: string
  jobName: string
  result: 'success' | 'failed' | 'cancelled'
  snapshotPath: string | null
}): void {
  const printer = printerManager.getPrinter(event.printerId)
  if (!printer) return
  printerEvents.emit('print-job.finished', {
    jobId: event.jobId,
    printer,
    jobName: event.jobName,
    result: event.result,
    snapshotPath: event.snapshotPath
  })
}

async function readPrinterTenantId(printerId: string): Promise<string | null> {
  if (!printerId) return null
  const row = await rootPrisma.printer.findUnique({
    where: { id: printerId },
    select: { tenantId: true }
  })
  return row?.tenantId ?? null
}

export function setPrintJobSnapshotEnsurerForTests(
  ensurer: typeof ensurePrintJobSnapshot | null
): void {
  printJobSnapshotEnsurer = ensurer ?? ensurePrintJobSnapshot
}

export function startPrintJobRecorder(): void {
  if (started) return
  started = true
  printerEvents.on('print.job.starting', onTrackedJobStarting)
  printerEvents.on('status', onStatus)
  printerEvents.on('job.started', onJobStarted)
  printerEvents.on('job.finished', onJobFinished)
}

export function stopPrintJobRecorder(): void {
  if (!started) return
  started = false
  printerEvents.off('print.job.starting', onTrackedJobStarting)
  printerEvents.off('status', onStatus)
  printerEvents.off('job.started', onJobStarted)
  printerEvents.off('job.finished', onJobFinished)
  clearDelayedThumbnailPersists()
  activeJobs.clear()
  activeJobTaskIds.clear()
  activeJobPrinterFilePaths.clear()
  externalJobActivations.clear()
  pendingTrackedJobActivations.clear()
  trackedStartGraceUntil.clear()
}

export async function reserveTrackedPrintJobStart(input: {
  jobId?: string
  printerId: string
  jobName: string
  fileName: string
  metadata: PendingPrintJobSource
}): Promise<string> {
  const jobId = input.jobId ?? input.metadata.jobId ?? randomUUID()
  const metadata = {
    ...input.metadata,
    jobId
  }

  registerPendingPrintJobSource(input.printerId, metadata)
  await upsertTrackedPrintJobRecord({
    jobId,
    printerId: input.printerId,
    jobName: input.jobName,
    metadata
  })
  printerEvents.emit('print.job.starting', {
    printerId: input.printerId,
    jobId,
    taskId: normalizeActivePrintTaskId(metadata.taskId),
    fileName: input.fileName
  })
  return jobId
}

export async function startTrackedPrintJob(input: {
  jobId?: string
  printerId: string
  jobName: string
  fileName: string
  metadata: PendingPrintJobSource
  publish: () => boolean
}): Promise<string | null> {
  const jobId = await reserveTrackedPrintJobStart(input)
  if (input.publish()) return jobId

  await failTrackedPrintJobStart({
    printerId: input.printerId,
    jobId
  })
  return null
}

export async function failTrackedPrintJobStart(input: {
  printerId: string
  jobId: string
}): Promise<void> {
  const pending = peekPendingPrintJobSource(input.printerId)
  if (pending?.jobId === input.jobId) {
    clearPendingPrintJobSource(input.printerId)
  }
  await clearPendingDispatchedPrintSource(input.printerId, input.jobId)
  await finishTrackedPrintJobRecord({
    jobId: input.jobId,
    result: 'failed'
  })
}

export async function resolveRelevantPrintJobId(printerId: string): Promise<string | null> {
  const activeJobId = activeJobs.get(printerId)
  if (activeJobId) return activeJobId

  const pendingJobId = peekPendingPrintJobSource(printerId)?.jobId ?? null
  return pendingJobId
}

export async function resolvePrintJobIdByTaskId(printerId: string, taskId: string | null): Promise<string | null> {
  const normalizedTaskId = normalizeActivePrintTaskId(taskId)
  if (!normalizedTaskId) return null

  const row = await readPreferredUnfinishedPrintJob(printerId, normalizedTaskId)

  return row?.id ?? null
}

function onTrackedJobStarting(event: { printerId: string }): void {
  trackedStartGraceUntil.set(event.printerId, Date.now() + TRACKED_START_GRACE_MS)
}

async function onJobStarted(event: { printer: { id: string; name: string }; jobName: string }): Promise<void> {
  const existingJobId = activeJobs.get(event.printer.id)
  if (existingJobId) return

  const status = printerManager.getStatus(event.printer.id)
  const taskId = normalizeActivePrintTaskId(status?.taskId)
  try {
    const trackedJobId = await activatePendingTrackedPrintJob({
      printerId: event.printer.id,
      observedJobName: event.jobName,
      observedTaskId: taskId,
      observedPrinterFilePath: status?.gcodeFile ?? null
    })
    if (trackedJobId) return

    if (taskId) {
      await activateExternalPrintJob({
        printerId: event.printer.id,
        observedJobName: event.jobName,
        taskId,
        observedPrinterFilePath: status?.gcodeFile ?? null
      })
    }
  } catch (error) {
    console.error('Failed to record print job start', error)
  }
}

export async function createPrintJobStartRecord(input: {
  jobId?: string
  printerId: string
  jobName: string
  metadata: PendingPrintJobSource | null
  startedAt?: Date
}): Promise<PrintJobStartRecord> {
  const printer = await rootPrisma.printer.findUnique({
    where: { id: input.printerId },
    select: { tenantId: true }
  })
  if (!printer) {
    throw new Error(`Printer not found for print job record: ${input.printerId}`)
  }

  const data = {
    ...(input.jobId ? { id: input.jobId } : {}),
    tenantId: printer.tenantId,
    printerId: input.printerId,
    taskId: normalizeActivePrintTaskId(input.metadata?.taskId),
    printerFilePath: normalizeExactPrinterFilePath(input.metadata?.printerFilePath),
    jobName: input.jobName,
    fileId: input.metadata?.fileId ?? null,
    fileName: input.metadata?.fileName ?? null,
    fileSizeBytes: input.metadata?.fileSizeBytes ?? null,
    plate: input.metadata?.plate ?? null,
    useAms: input.metadata?.useAms ?? null,
    bedLevel: input.metadata?.bedLevel ?? null,
    amsMapping: input.metadata?.amsMapping ? JSON.stringify(input.metadata.amsMapping) : null,
    startedAt: input.startedAt ?? new Date(),
    sourceType: mapStoredJobKind(input.metadata?.jobKind ?? 'external'),
    calibrationOption: input.metadata?.calibrationOption ?? null,
    result: 'unknown' as const
  }

  let created: PrintJobStartRecord
  try {
    created = await rootPrisma.printJob.create({ data })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    console.warn('Recording print history without calibration columns; PrintJob migration is missing')
    created = await rootPrisma.printJob.create({
      data: {
        ...(input.jobId ? { id: input.jobId } : {}),
        tenantId: data.tenantId,
        printerId: data.printerId,
        jobName: data.jobName,
        fileId: data.fileId,
        fileName: data.fileName,
        fileSizeBytes: data.fileSizeBytes,
        plate: data.plate,
        useAms: data.useAms,
        bedLevel: data.bedLevel,
        amsMapping: data.amsMapping,
        startedAt: data.startedAt,
        result: data.result
      }
    })
  }
  // Each created job that targets a library file is one print of that file: roll it
  // into the file's denormalized print-history counters for the library sorts.
  await bumpLibraryFilePrintStats(data.fileId, data.startedAt)
  return created
}

/**
 * Roll a recorded print into a library file's denormalized print-history counters
 * (`printCount` / `lastPrintedAt`), which power the "most printed" / "last printed"
 * library sorts. Best-effort: a deleted file (no row) or a DB still missing the
 * columns is ignored rather than failing the print recording.
 */
async function bumpLibraryFilePrintStats(fileId: string | null | undefined, printedAt: Date): Promise<void> {
  if (!fileId) return
  try {
    await rootPrisma.libraryFile.update({
      where: { id: fileId },
      data: { printCount: { increment: 1 }, lastPrintedAt: printedAt }
    })
  } catch (error) {
    if (isMissingColumnError(error)) return
    // P2025 = record to update not found (file recycled/hard-deleted since dispatch).
    if ((error as { code?: string }).code === 'P2025') return
    console.warn('[print-job-recorder] failed to update library file print stats', (error as Error).message)
  }
}

export async function upsertTrackedPrintJobRecord(input: {
  jobId: string
  printerId: string
  jobName: string
  metadata: PendingPrintJobSource
}): Promise<void> {
  const existing = await rootPrisma.printJob.findUnique({
    where: { id: input.jobId },
    select: { id: true }
  })

  if (existing) {
    await rootPrisma.printJob.update({
      where: { id: input.jobId },
      data: {
        printerId: input.printerId,
        taskId: normalizeActivePrintTaskId(input.metadata.taskId),
        printerFilePath: normalizeExactPrinterFilePath(input.metadata.printerFilePath),
        jobName: input.jobName,
        fileId: input.metadata.fileId,
        fileName: input.metadata.fileName,
        fileSizeBytes: input.metadata.fileSizeBytes,
        plate: input.metadata.plate,
        useAms: input.metadata.useAms,
        bedLevel: input.metadata.bedLevel,
        amsMapping: input.metadata.amsMapping ? JSON.stringify(input.metadata.amsMapping) : null,
        startedAt: new Date(),
        finishedAt: null,
        progressPercent: null,
        durationSeconds: null,
        result: 'unknown',
        sourceType: mapStoredJobKind(input.metadata.jobKind),
        calibrationOption: input.metadata.calibrationOption
      }
    })
  } else {
    await createPrintJobStartRecord({
      jobId: input.jobId,
      printerId: input.printerId,
      jobName: input.jobName,
      metadata: input.metadata,
      startedAt: new Date()
    })
  }

  broadcastJobsChanged(await readPrinterTenantId(input.printerId))
}

async function resolvePrintJobFilamentUsage(input: {
  tenantId: string
  sourceType: string
  fileId: string | null
  plate: number | null
}): Promise<{
  usedGrams: number | null
  usedMeters: number | null
} | null> {
  if (input.sourceType !== 'library' || !input.fileId || input.plate == null) {
    return null
  }

  const file = await rootPrisma.libraryFile.findUnique({
    where: { id: input.fileId },
    select: {
      tenantId: true,
      kind: true,
      ownerBridgeId: true,
      storedPath: true
    }
  })
  if (!file || file.tenantId !== input.tenantId || (file.kind !== '3mf' && file.kind !== 'gcode')) return null

  try {
    return await readLibraryThreeMfPlateUsage(file, input.plate)
  } catch (error) {
    console.warn(`[print-job-recorder] filament usage lookup failed for file ${input.fileId} (plate ${input.plate})`, (error as Error).message)
    return null
  }
}

function mapStoredJobKind(jobKind: PendingPrintJobSource['jobKind']): 'library' | 'calibration' | 'external' {
  switch (jobKind) {
    case 'calibration':
      return 'calibration'
    case 'external':
      return 'external'
    case 'file':
    default:
      return 'library'
  }
}

async function readUnfinishedPrintJobRows(printerId: string, taskId: string): Promise<UnfinishedPrintJobRow[]> {
  return await rootPrisma.printJob.findMany({
    where: {
      printerId,
      finishedAt: null,
      taskId
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      printerId: true,
      taskId: true,
      jobName: true,
      printerFilePath: true,
      sourceType: true,
      fileId: true,
      thumbnailPath: true,
      startedAt: true
    }
  })
}

async function readAllUnfinishedPrintJobRows(printerId: string): Promise<UnfinishedPrintJobRow[]> {
  return await rootPrisma.printJob.findMany({
    where: {
      printerId,
      finishedAt: null
    },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      printerId: true,
      taskId: true,
      jobName: true,
      printerFilePath: true,
      sourceType: true,
      fileId: true,
      thumbnailPath: true,
      startedAt: true
    }
  })
}

function pickPreferredUnfinishedPrintJob(rows: UnfinishedPrintJobRow[]): UnfinishedPrintJobRow | null {
  if (rows.length === 0) return null

  return rows.reduce((best, current) => {
    const currentScore = scoreUnfinishedPrintJob(current)
    const bestScore = scoreUnfinishedPrintJob(best)
    if (currentScore !== bestScore) return currentScore > bestScore ? current : best

    return current.startedAt.getTime() > best.startedAt.getTime() ? current : best
  })
}

function scoreUnfinishedPrintJob(row: UnfinishedPrintJobRow): number {
  let score = 0
  if (row.sourceType === 'library') score += 100
  if (row.fileId) score += 50
  if (row.thumbnailPath) score += 10
  if (row.printerFilePath) score += 5
  return score
}

async function readPreferredUnfinishedPrintJob(printerId: string, taskId: string): Promise<UnfinishedPrintJobRow | null> {
  const rows = await readUnfinishedPrintJobRows(printerId, taskId)
  return pickPreferredUnfinishedPrintJob(rows)
}

async function closeDuplicateUnfinishedPrintJobs(input: {
  printerId: string
  taskId: string
  preferredJobId: string
  finishedAt?: Date
  progressPercent?: number | null
  result?: 'success' | 'failed' | 'cancelled' | 'unknown'
}): Promise<void> {
  const rows = await readUnfinishedPrintJobRows(input.printerId, input.taskId)
  const duplicateIds = rows
    .filter((row) => row.id !== input.preferredJobId)
    .map((row) => row.id)
  if (duplicateIds.length === 0) return

  await rootPrisma.printJob.updateMany({
    where: {
      id: { in: duplicateIds }
    },
    data: {
      finishedAt: input.finishedAt ?? new Date(),
      progressPercent: input.progressPercent ?? null,
      result: input.result ?? 'unknown'
    }
  })

  console.warn(
    `[print-job-recorder] closed ${duplicateIds.length} duplicate unfinished print job${duplicateIds.length === 1 ? '' : 's'} for ${input.printerId}:${input.taskId}`
  )
  broadcastJobsChanged(await readPrinterTenantId(input.printerId))
}

async function closeStaleUnfinishedPrintJobsForPrinter(input: {
  printerId: string
  preferredJobId: string
  finishedAt?: Date
}): Promise<void> {
  const rows = await readAllUnfinishedPrintJobRows(input.printerId)
  const staleJobIds = rows
    .filter((row) => row.id !== input.preferredJobId)
    .map((row) => row.id)
  if (staleJobIds.length === 0) return

  await rootPrisma.printJob.updateMany({
    where: {
      id: { in: staleJobIds }
    },
    data: {
      finishedAt: input.finishedAt ?? new Date(),
      progressPercent: null,
      result: 'unknown'
    }
  })

  console.warn(
    `[print-job-recorder] closed ${staleJobIds.length} stale unfinished print job${staleJobIds.length === 1 ? '' : 's'} for ${input.printerId} after terminal status reconciliation`
  )
  broadcastJobsChanged(await readPrinterTenantId(input.printerId))
}

function mapTerminalStatusResult(stage: PrinterStatus['stage']): 'success' | 'failed' | 'unknown' {
  if (stage === 'failed') return 'failed'
  if (stage === 'finished') return 'success'
  return 'unknown'
}

async function reconcileTerminalStatusWithoutMatchingTask(status: PrinterStatus): Promise<void> {
  const rows = await readAllUnfinishedPrintJobRows(status.printerId)
  const preferred = pickPreferredUnfinishedPrintJob(rows)
  if (!preferred) return

  const finishedAt = new Date()
  await finishTrackedPrintJobRecord({
    jobId: preferred.id,
    result: mapTerminalStatusResult(status.stage),
    progressPercent: normalizeProgressPercent(status.progressPercent),
    captureSnapshot: true
  })
  await closeStaleUnfinishedPrintJobsForPrinter({
    printerId: status.printerId,
    preferredJobId: preferred.id,
    finishedAt
  })
}

export async function finishTrackedPrintJobRecord(input: {
  jobId: string
  result: 'success' | 'failed' | 'cancelled' | 'unknown'
  progressPercent?: number | null
  captureSnapshot?: boolean
}): Promise<void> {
  const existing = await rootPrisma.printJob.findUnique({
    where: { id: input.jobId },
    select: {
      startedAt: true,
      finishedAt: true,
      printerId: true,
      jobName: true,
      taskId: true,
      tenantId: true,
      sourceType: true,
      fileId: true,
      plate: true
    }
  })
  if (!existing) return

  const finishedAt = existing.finishedAt ?? new Date()
  const filamentUsage = input.result === 'unknown'
    ? null
    : await resolvePrintJobFilamentUsage({
      tenantId: existing.tenantId,
        sourceType: existing.sourceType,
        fileId: existing.fileId,
        plate: existing.plate
      })

  await rootPrisma.printJob.update({
    where: { id: input.jobId },
    data: {
      finishedAt,
      progressPercent: input.progressPercent ?? null,
      durationSeconds: existing.startedAt
        ? Math.max(0, Math.round((finishedAt.getTime() - existing.startedAt.getTime()) / 1000))
        : null,
      filamentUsedGrams: filamentUsage?.usedGrams ?? null,
      filamentUsedMeters: filamentUsage?.usedMeters ?? null,
      result: input.result
    }
  })

  if (existing.taskId) {
    await closeDuplicateUnfinishedPrintJobs({
      printerId: existing.printerId,
      taskId: existing.taskId,
      preferredJobId: input.jobId,
      finishedAt,
      progressPercent: input.progressPercent,
      result: input.result
    })
  }

  if (input.result !== 'unknown') {
    try {
      await recordFinishedPrinterStats(input.jobId)
    } catch (error) {
      console.error('Failed to record printer stats for finished job', error)
    }
  }

  let snapshotPath: string | null = null
  if (input.captureSnapshot) {
    const printer = printerManager.getPrinter(existing.printerId)
    if (printer) {
      try {
        snapshotPath = await printJobSnapshotEnsurer(printer, input.jobId)
      } catch (error) {
        console.error('Failed to persist print job snapshot', error)
      }
    }
  }

  if (input.result !== 'unknown') {
    emitRecordedJobFinished({
      jobId: input.jobId,
      printerId: existing.printerId,
      jobName: existing.jobName,
      result: input.result,
      snapshotPath
    })
  }

  broadcastJobsChanged(await readPrinterTenantId(existing.printerId))
}

export async function cancelTrackedPrintJobRecord(input: {
  printerId: string
  jobId: string
  jobName?: string
  metadata?: PendingPrintJobSource | null
  startedAt?: Date
}): Promise<void> {
  const pending = peekPendingPrintJobSource(input.printerId)
  if (pending?.jobId === input.jobId) {
    clearPendingPrintJobSource(input.printerId)
  }
  await clearPendingDispatchedPrintSource(input.printerId, input.jobId)

  const existing = await rootPrisma.printJob.findUnique({
    where: { id: input.jobId },
    select: { id: true }
  })

  if (!existing && input.metadata && input.jobName) {
    await createPrintJobStartRecord({
      jobId: input.jobId,
      printerId: input.printerId,
      jobName: input.jobName,
      metadata: input.metadata,
      startedAt: input.startedAt ?? new Date()
    })
  }

  await finishTrackedPrintJobRecord({
    jobId: input.jobId,
    result: 'cancelled'
  })
}

async function onJobFinished(event: { printer: { id: string }; jobName: string; result: 'success' | 'failed' | 'cancelled' }): Promise<void> {
  let jobId = activeJobs.get(event.printer.id)
  trackedStartGraceUntil.delete(event.printer.id)
  const trackedTaskId = activeJobTaskIds.get(event.printer.id) ?? normalizeActivePrintTaskId(printerManager.getStatus(event.printer.id)?.taskId)
  if (!jobId) {
    const taskId = normalizeActivePrintTaskId(printerManager.getStatus(event.printer.id)?.taskId)
    if (!taskId) return

    const existing = await readPreferredUnfinishedPrintJob(event.printer.id, taskId)
    jobId = existing?.id
  }
  if (!jobId) return
  activeJobs.delete(event.printer.id)
  activeJobTaskIds.delete(event.printer.id)
  activeJobPrinterFilePaths.delete(event.printer.id)
  const finishedAt = new Date()
  const progressPercent = normalizeProgressPercent(printerManager.getStatus(event.printer.id)?.progressPercent)
  try {
    const existing = await rootPrisma.printJob.findUnique({
      where: { id: jobId },
      select: {
        startedAt: true,
        tenantId: true,
        sourceType: true,
        fileId: true,
        plate: true
      }
    })
    const filamentUsage = await resolvePrintJobFilamentUsage({
      tenantId: existing?.tenantId ?? '',
      sourceType: existing?.sourceType ?? 'external',
      fileId: existing?.fileId ?? null,
      plate: existing?.plate ?? null
    })
    await rootPrisma.printJob.update({
      where: { id: jobId },
      data: {
        finishedAt,
        progressPercent,
        durationSeconds: existing
          ? Math.max(0, Math.round((finishedAt.getTime() - existing.startedAt.getTime()) / 1000))
          : null,
        filamentUsedGrams: filamentUsage?.usedGrams ?? null,
        filamentUsedMeters: filamentUsage?.usedMeters ?? null,
        result: event.result
      }
    })
    if (trackedTaskId) {
      await closeDuplicateUnfinishedPrintJobs({
        printerId: event.printer.id,
        taskId: trackedTaskId,
        preferredJobId: jobId,
        finishedAt,
        progressPercent,
        result: event.result
      })
    }
    try {
      await recordFinishedPrinterStats(jobId)
    } catch (error) {
      console.error('Failed to record printer stats for finished job', error)
    }
    const printer = printerManager.getPrinter(event.printer.id)
    let snapshotPath: string | null = null
    if (printer) {
      try {
        snapshotPath = await printJobSnapshotEnsurer(printer, jobId)
      } catch (error) {
        console.error('Failed to persist print job snapshot', error)
      }
    }
    emitRecordedJobFinished({
      jobId,
      printerId: event.printer.id,
      jobName: event.jobName,
      result: event.result,
      snapshotPath
    })
    broadcastJobsChanged(await readPrinterTenantId(event.printer.id))
  } catch (error) {
    console.error('Failed to record print job finish', error)
  } finally {
    if (trackedTaskId) {
      void clearDispatchedPrintSource(event.printer.id, trackedTaskId)
    } else {
      void clearPendingDispatchedPrintSource(event.printer.id, jobId)
    }
  }
}

async function onStatus(status: PrinterStatus): Promise<void> {
  const activeJobId = activeJobs.get(status.printerId)
  if (activeJobId) {
    await syncActiveJobIdentity(status.printerId, activeJobId, status.taskId, status.gcodeFile)
    return
  }

  const withinTrackedStartGrace = (trackedStartGraceUntil.get(status.printerId) ?? 0) > Date.now()
  if (withinTrackedStartGrace) {
    if (status.online && !isTerminalPrintJobStage(status.stage)) {
      const trackedJobId = await activatePendingTrackedPrintJob({
        printerId: status.printerId,
        observedJobName: null,
        observedTaskId: status.taskId,
        observedPrinterFilePath: status.gcodeFile
      })
      if (trackedJobId) return
    }
    return
  }

  if (!status.online) return

  if (!isTerminalPrintJobStage(status.stage)) {
    const taskId = normalizeActivePrintTaskId(status.taskId)
    if (!taskId) return
    await activateExternalPrintJob({
      printerId: status.printerId,
      observedJobName: status.jobName ?? deriveObservedJobName(status.gcodeFile, status.taskId),
      taskId,
      observedPrinterFilePath: status.gcodeFile
    })
    return
  }

  const taskId = normalizeActivePrintTaskId(status.taskId)
  if (!taskId) {
    try {
      await reconcileTerminalStatusWithoutMatchingTask(status)
    } catch (error) {
      console.error('Failed to reconcile stale print jobs from terminal printer status without task id', error)
    }
    return
  }

  const existing = await readPreferredUnfinishedPrintJob(status.printerId, taskId)
  if (!existing) {
    try {
      await reconcileTerminalStatusWithoutMatchingTask(status)
    } catch (error) {
      console.error('Failed to reconcile stale print jobs from terminal printer status without a matching task id', error)
    }
    return
  }

  try {
    await finishTrackedPrintJobRecord({
      jobId: existing.id,
      result: mapTerminalStatusResult(status.stage),
      progressPercent: normalizeProgressPercent(status.progressPercent),
      captureSnapshot: true
    })
    await closeStaleUnfinishedPrintJobsForPrinter({
      printerId: status.printerId,
      preferredJobId: existing.id
    })
  } catch (error) {
    console.error('Failed to reconcile print job from restored printer status', error)
  }
}

async function syncActiveJobIdentity(
  printerId: string,
  jobId: string,
  nextTaskIdValue: string | null | undefined,
  nextPrinterFilePathValue: string | null | undefined
): Promise<void> {
  const nextTaskId = normalizeActivePrintTaskId(nextTaskIdValue)
  const nextPrinterFilePath = normalizeExactPrinterFilePath(nextPrinterFilePathValue)
  const currentTaskId = activeJobTaskIds.get(printerId) ?? null
  const currentPrinterFilePath = activeJobPrinterFilePaths.get(printerId) ?? null
  const needsTaskUpdate = !!nextTaskId && currentTaskId !== nextTaskId
  const needsPrinterFilePathUpdate = !!nextPrinterFilePath && currentPrinterFilePath !== nextPrinterFilePath
  if (!needsTaskUpdate && !needsPrinterFilePathUpdate) return

  const data: { taskId?: string; printerFilePath?: string } = {}
  if (needsTaskUpdate && nextTaskId) data.taskId = nextTaskId
  if (needsPrinterFilePathUpdate && nextPrinterFilePath) data.printerFilePath = nextPrinterFilePath

  await rootPrisma.printJob.update({
    where: { id: jobId },
    data
  })

  if (needsTaskUpdate && nextTaskId) {
    if (currentTaskId) {
      await reassignDispatchedPrintSourceTask(printerId, currentTaskId, nextTaskId)
    } else {
      await assignPendingDispatchedPrintSourceTask(printerId, jobId, nextTaskId)
    }
    activeJobTaskIds.set(printerId, nextTaskId)
  }
  if (needsPrinterFilePathUpdate) {
    activeJobPrinterFilePaths.set(printerId, nextPrinterFilePath)
  }

  const effectiveTaskId = nextTaskId ?? currentTaskId
  if (effectiveTaskId) {
    await closeDuplicateUnfinishedPrintJobs({
      printerId,
      taskId: effectiveTaskId,
      preferredJobId: jobId
    })
  }
}

async function activatePendingTrackedPrintJob(input: {
  printerId: string
  observedJobName: string | null
  observedTaskId: string | null
  observedPrinterFilePath: string | null
}): Promise<string | null> {
  const pendingActivation = pendingTrackedJobActivations.get(input.printerId)
  if (pendingActivation) return await pendingActivation

  const activation = (async (): Promise<string | null> => {
    const metadata = peekPendingPrintJobSource(input.printerId)
    if (!metadata?.jobId) {
      trackedStartGraceUntil.delete(input.printerId)
      return null
    }

    const dispatched = await rootPrisma.printJob.findUnique({
      where: { id: metadata.jobId },
      select: { id: true, jobName: true, taskId: true, printerFilePath: true }
    })
    if (!dispatched) return null

    clearPendingPrintJobSource(input.printerId)
    trackedStartGraceUntil.delete(input.printerId)

    activeJobs.set(input.printerId, dispatched.id)
    activeJobTaskIds.set(input.printerId, normalizeActivePrintTaskId(dispatched.taskId))
    activeJobPrinterFilePaths.set(input.printerId, normalizeExactPrinterFilePath(dispatched.printerFilePath))

    const nextJobName = input.observedJobName || dispatched.jobName || metadata.fileName || metadata.jobId
    await syncActiveJobIdentity(input.printerId, dispatched.id, input.observedTaskId, input.observedPrinterFilePath)
    const effectiveTaskId = normalizeActivePrintTaskId(input.observedTaskId) ?? normalizeActivePrintTaskId(dispatched.taskId)
    if (effectiveTaskId) {
      await closeDuplicateUnfinishedPrintJobs({
        printerId: input.printerId,
        taskId: effectiveTaskId,
        preferredJobId: dispatched.id
      })
    }

    if (nextJobName && nextJobName !== dispatched.jobName) {
      await rootPrisma.printJob.update({
        where: { id: dispatched.id },
        data: { jobName: nextJobName }
      })
    }

    if (metadata.jobKind === 'file') {
      scheduleDelayedThumbnailPersist({
        jobId: dispatched.id,
        printerId: input.printerId,
        jobName: nextJobName,
        gcodeFile: printerManager.getStatus(input.printerId)?.gcodeFile ?? null,
        fileId: metadata.fileId ?? null,
        plate: metadata.plate ?? null
      })
    }

    emitRecordedJobStarted({
      jobId: dispatched.id,
      printerId: input.printerId,
      jobName: nextJobName
    })
    return dispatched.id
  })()

  pendingTrackedJobActivations.set(input.printerId, activation)
  try {
    return await activation
  } finally {
    if (pendingTrackedJobActivations.get(input.printerId) === activation) {
      pendingTrackedJobActivations.delete(input.printerId)
    }
  }
}

async function activateExternalPrintJob(input: {
  printerId: string
  observedJobName: string | null
  taskId: string
  observedPrinterFilePath: string | null
}): Promise<string | null> {
  const activationKey = `${input.printerId}:${input.taskId}`
  const pendingActivation = externalJobActivations.get(activationKey)
  if (pendingActivation) return await pendingActivation

  const activation = (async (): Promise<string | null> => {
    const inferredPlate = inferObservedPrintPlateIndex({
      jobName: input.observedJobName,
      gcodeFile: input.observedPrinterFilePath
    })
    const resolvedIdentity = await resolveExternalPrintIdentity({
      printerId: input.printerId,
      observedJobName: input.observedJobName,
      observedPrinterFilePath: input.observedPrinterFilePath,
      plate: inferredPlate
    })
    const nextObservedJobName = resolvedIdentity.jobName ?? input.observedJobName
    const nextPrinterFilePath = normalizeExactPrinterFilePath(resolvedIdentity.printerFilePath)
    const matchedLibraryFile = await resolveObservedLibraryFile({
      printerId: input.printerId,
      observedJobName: nextObservedJobName,
      observedPrinterFilePath: nextPrinterFilePath
    })
    const existing = await rootPrisma.printJob.findFirst({
      where: {
        printerId: input.printerId,
        finishedAt: null,
        taskId: input.taskId
      },
      orderBy: { startedAt: 'desc' },
      select: { id: true, jobName: true, printerFilePath: true, plate: true, fileId: true, thumbnailPath: true }
    })

    if (existing) {
      activeJobs.set(input.printerId, existing.id)
      activeJobTaskIds.set(input.printerId, input.taskId)
      const currentPrinterFilePath = normalizeExactPrinterFilePath(existing.printerFilePath)
      activeJobPrinterFilePaths.set(input.printerId, currentPrinterFilePath)
      if (
        (nextObservedJobName && nextObservedJobName !== existing.jobName)
        || (nextPrinterFilePath && nextPrinterFilePath !== currentPrinterFilePath)
        || (inferredPlate != null && inferredPlate !== existing.plate)
      ) {
        await rootPrisma.printJob.update({
          where: { id: existing.id },
          data: {
            ...(nextObservedJobName && nextObservedJobName !== existing.jobName ? { jobName: nextObservedJobName } : {}),
            ...(nextPrinterFilePath && nextPrinterFilePath !== currentPrinterFilePath
              ? { printerFilePath: nextPrinterFilePath }
              : {}),
            ...(inferredPlate != null && inferredPlate !== existing.plate ? { plate: inferredPlate } : {}),
            ...(matchedLibraryFile && matchedLibraryFile.id !== existing.fileId
              ? {
                  fileId: matchedLibraryFile.id,
                  fileName: matchedLibraryFile.name,
                  fileSizeBytes: matchedLibraryFile.sizeBytes,
                  sourceType: 'library'
                }
              : {})
          }
        })
        if (nextPrinterFilePath) {
          activeJobPrinterFilePaths.set(input.printerId, nextPrinterFilePath)
        }
      }
      if (matchedLibraryFile && matchedLibraryFile.id !== existing.fileId) {
        // An external print (started off PrintStream) was just attributed to a library
        // file for the first time — count it toward that file's print history.
        await bumpLibraryFilePrintStats(matchedLibraryFile.id, new Date())
      }
      if (matchedLibraryFile && (!existing.thumbnailPath || matchedLibraryFile.id !== existing.fileId)) {
        scheduleDelayedThumbnailPersist({
          jobId: existing.id,
          printerId: input.printerId,
          jobName: nextObservedJobName || input.taskId,
          gcodeFile: nextPrinterFilePath,
          fileId: matchedLibraryFile.id,
          plate: inferredPlate
        })
      }
      await closeDuplicateUnfinishedPrintJobs({
        printerId: input.printerId,
        taskId: input.taskId,
        preferredJobId: existing.id
      })
      return existing.id
    }

    const created = await createPrintJobStartRecord({
      printerId: input.printerId,
      jobName: nextObservedJobName || input.taskId,
      metadata: {
        jobKind: matchedLibraryFile ? 'file' : 'external',
        jobId: null,
        taskId: input.taskId,
        printerFilePath: nextPrinterFilePath,
        fileId: matchedLibraryFile?.id ?? null,
        fileName: matchedLibraryFile?.name ?? null,
        fileSizeBytes: matchedLibraryFile?.sizeBytes ?? null,
        sourceKind: toPendingSourceKind(matchedLibraryFile?.kind),
        plate: inferredPlate,
        useAms: null,
        bedLevel: null,
        amsMapping: null,
        calibrationOption: null
      }
    })

    activeJobs.set(input.printerId, created.id)
    activeJobTaskIds.set(input.printerId, input.taskId)
    activeJobPrinterFilePaths.set(input.printerId, nextPrinterFilePath)
    if (matchedLibraryFile) {
      scheduleDelayedThumbnailPersist({
        jobId: created.id,
        printerId: input.printerId,
        jobName: nextObservedJobName || input.taskId,
        gcodeFile: nextPrinterFilePath,
        fileId: matchedLibraryFile.id,
        plate: inferredPlate
      })
    }
    await closeDuplicateUnfinishedPrintJobs({
      printerId: input.printerId,
      taskId: input.taskId,
      preferredJobId: created.id
    })
    emitRecordedJobStarted({
      jobId: created.id,
      printerId: input.printerId,
      jobName: nextObservedJobName || input.taskId
    })
    return created.id
  })()

  externalJobActivations.set(activationKey, activation)
  try {
    return await activation
  } finally {
    if (externalJobActivations.get(activationKey) === activation) {
      externalJobActivations.delete(activationKey)
    }
  }
}

async function persistJobThumbnail(input: {
  jobId: string
  printerId: string
  jobName: string
  gcodeFile: string | null
  fileId: string | null
  plate: number | null
}): Promise<void> {
  try {
    const thumbnailPath = await persistHistoryThumbnailFromLibrary({
      jobId: input.jobId,
      preferredFileIds: [input.fileId],
      plate: input.plate ?? 1
    })
    if (!thumbnailPath) return
    await rootPrisma.printJob.update({
      where: { id: input.jobId },
      data: { thumbnailPath }
    })
  } catch (error) {
    console.error('Failed to persist print job thumbnail', error)
  }
}

async function resolveObservedLibraryFile(input: {
  printerId: string
  observedJobName: string | null
  observedPrinterFilePath: string | null
}): Promise<ObservedLibraryFileMatch | null> {
  const tenantId = await readPrinterTenantId(input.printerId).catch((error) => {
    console.warn(`[print-job-recorder] tenant lookup failed for printer ${input.printerId} during library match`, (error as Error).message)
    return null
  })
  if (!tenantId) return null

  const files = await rootPrisma.libraryFile.findMany({
    where: visibleLibraryFilesWhere({ tenantId }),
    select: { id: true, name: true, storedPath: true, sizeBytes: true, kind: true }
  }).catch((error) => {
    console.warn(`[print-job-recorder] library file lookup failed for printer ${input.printerId}`, (error as Error).message)
    return []
  })
  if (files.length === 0) return null

  const candidates = new Set<string>()
  for (const value of [
    input.observedJobName,
    deriveObservedJobName(input.observedPrinterFilePath, null),
    input.observedPrinterFilePath ? path.basename(input.observedPrinterFilePath) : null
  ]) {
    const normalized = normalizeObservedLibraryReference(value)
    if (normalized) candidates.add(normalized)
  }
  if (candidates.size === 0) return null

  return files.find((file) => {
    const fileCandidates = [
      normalizeObservedLibraryReference(file.name),
      normalizeObservedLibraryReference(file.storedPath),
      normalizeObservedLibraryReference(path.basename(file.storedPath))
    ]
    return fileCandidates.some((candidate) => candidate != null && candidates.has(candidate))
  }) ?? null
}

function normalizeObservedLibraryReference(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim()
  if (!normalizedValue) return null

  return path.basename(normalizedValue)
    .replace(/\.(gcode(?:\.3mf)?|3mf)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase() || null
}

function toPendingSourceKind(value: string | null | undefined): '3mf' | 'gcode' | null {
  return value === '3mf' || value === 'gcode' ? value : null
}

function normalizeProgressPercent(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

function deriveObservedJobName(gcodeFile: string | null | undefined, fallbackTaskId: string | null | undefined): string | null {
  if (typeof gcodeFile === 'string' && gcodeFile.trim().length > 0) {
    const fileName = path.basename(gcodeFile)
    return fileName.replace(/\.(gcode(?:\.3mf)?|3mf)$/i, '')
  }
  return normalizeActivePrintTaskId(fallbackTaskId)
}

async function resolveExternalPrintIdentity(input: {
  printerId: string
  observedJobName: string | null
  observedPrinterFilePath: string | null
  plate: number | null
}): Promise<{ jobName: string | null; printerFilePath: string | null }> {
  const printer = printerManager.getPrinter(input.printerId)
  const observedJobName = input.observedJobName?.trim() || null
  const normalizedObservedPrinterFilePath = normalizeExactPrinterFilePath(input.observedPrinterFilePath)
  if (!printer) {
    return {
      jobName: observedJobName,
      printerFilePath: normalizedObservedPrinterFilePath
    }
  }

  const resolvedPrinterFilePath = normalizedObservedPrinterFilePath && !isMetadataPlateGcodePath(normalizedObservedPrinterFilePath)
    ? normalizedObservedPrinterFilePath
    : await resolvePrinterCoverPath(
      printer,
      observedJobName ?? '',
      normalizedObservedPrinterFilePath ?? buildPlateGcodeFileHint(input.plate),
      { allowLatestFallback: false }
    ).catch(() => null)

  const resolvedPlateName = resolvedPrinterFilePath && input.plate != null
    ? await readPrinterStorageThreeMfIndex(printer, resolvedPrinterFilePath)
      .then((index) => index?.plates.find((entry) => entry.index === input.plate)?.name?.trim() || null)
      .catch(() => null)
    : null

  return {
    jobName: buildResolvedExternalPrintJobName(observedJobName, resolvedPrinterFilePath, resolvedPlateName),
    printerFilePath: resolvedPrinterFilePath ?? normalizedObservedPrinterFilePath
  }
}

export function buildResolvedExternalPrintJobName(
  jobName: string | null | undefined,
  printerFilePath: string | null | undefined,
  plateName: string | null | undefined
): string | null {
  const normalizedPlateName = plateName?.trim()
  const normalizedJobName = jobName?.trim() || null
  const archiveJobName = deriveObservedJobName(printerFilePath ?? null, null)
  if (!normalizedPlateName) return normalizedJobName ?? archiveJobName

  for (const candidate of [normalizedJobName, archiveJobName]) {
    const split = splitGenericObservedPlateJobName(candidate)
    if (!split) continue
    return `${split.title} - ${normalizedPlateName}`
  }

  return normalizedJobName ?? archiveJobName
}

function splitGenericObservedPlateJobName(value: string | null | undefined): { title: string; plateLabel: string } | null {
  const normalizedValue = value?.trim()
  if (!normalizedValue) return null

  const splitIndex = normalizedValue.lastIndexOf(' - ')
  if (splitIndex <= 0) return null

  const title = normalizedValue.slice(0, splitIndex).trim()
  const plateLabel = normalizedValue.slice(splitIndex + 3).trim()
  if (!title || !plateLabel || normalizeFallbackPlateLabel(plateLabel) === plateLabel) return null

  return { title, plateLabel }
}

function isTerminalPrintJobStage(stage: PrinterStatus['stage']): boolean {
  return stage === 'idle' || stage === 'finished' || stage === 'failed'
}

function scheduleDelayedThumbnailPersist(input: {
  jobId: string
  printerId: string
  jobName: string
  gcodeFile: string | null
  fileId: string | null
  plate: number | null
}): void {
  const timer = setTimeout(() => {
    delayedThumbnailPersists.delete(timer)
    void persistJobThumbnail(input)
  }, PRINT_JOB_THUMBNAIL_PERSIST_DELAY_MS)
  // Best-effort, deferred persist: it must not keep the event loop alive on its own. In the server
  // the HTTP/MQTT handles hold the process open so this still fires; under tests (and at shutdown) an
  // unfired persist is simply dropped instead of pinning the process for the full delay.
  timer.unref()
  delayedThumbnailPersists.add(timer)
}

function clearDelayedThumbnailPersists(): void {
  for (const timer of delayedThumbnailPersists.values()) {
    clearTimeout(timer)
  }
  delayedThumbnailPersists.clear()
}