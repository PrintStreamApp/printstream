/**
 * Server-side print dispatcher.
 *
 * Uploading a 3MF over a printer's FTPS server can take minutes on
 * slower models. This module lets HTTP requests enqueue work and return
 * immediately while the API process serializes dispatches per printer.
 * Queued jobs can be cancelled; uploading jobs honor cancellation before
 * publishing the MQTT start command.
 *
 * Restart contract (durability): dispatch jobs and the per-printer queues are
 * in-memory only. On a *graceful* shutdown (deploy/SIGTERM), `stop()` drains
 * in-flight work — queued jobs are cancelled and in-flight uploads aborted so
 * any landed SD bytes are deleted and the tracked PrintJob record is cancelled.
 * Jobs already 'sent' are left alone: the SD file is the live print, which keeps
 * running and reconciles via the print-job recorder on the next status. An
 * *ungraceful* crash (OOM/SIGKILL) skips `stop()`, so a job caught mid-upload
 * can still leak a partial SD file and leave a taskId-less 'unknown' PrintJob
 * row; that row self-heals only if a later terminal status arrives. A boot-time
 * reconcile for that crash case is intentionally deferred (it must not fail a
 * print that actually started — see `print-dispatch-jobs:rob-1`).
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AMS_LITE_MIXED_TRAY_INDEX_OFFSET,
  bridgeUpdateBlocksPrinting,
  bridgeUpdateStatusSchema,
  getPrinterPrintStartOptions,
  formatBytes,
  trayIndexToAmsSlot,
  type PrintDispatchJob,
  type PrintFromLibrary,
  type PrintNozzleOffsetCalibrationMode,
  type PrintOnOffAutoMode,
  type PrinterStatus,
  printerModelSchema,
  type PrinterModel
} from '@printstream/shared'
import { isSelfHostedDeployment } from './deployment-mode.js'
import { conflict } from './http-error.js'
import { readLibraryProjectFilamentChips } from './library-three-mf.js'
import { prisma, rootPrisma } from './prisma.js'
import { printerManager } from './printer-manager.js'
import {
  deletePrinterFile,
  uploadBridgeLibraryFileToPrinterPath,
  uploadBridgeLibraryPlateToPrinterPath,
  uploadFileToPrinter
} from './printer-ftp.js'
import { createSinglePlateThreeMf, readEntry } from './three-mf.js'
import { plateSkipIdentifyIdsFromModelSettingsXml } from './three-mf-output.js'
import { armPostStartObjectSkip } from './post-start-object-skip.js'
import { printGuards } from './print-guards.js'
import { type SnapshotLibraryFile } from './print-file-snapshots.js'
import { registerPendingDispatchedPrintSource } from './dispatched-print-source-cache.js'
import type { PendingPrintJobSource } from './pending-print-job-source.js'
import { normalizeExactPrinterFilePath } from './printer-file-path.js'
import { cancelTrackedPrintJobRecord, startTrackedPrintJob } from './print-job-recorder.js'
import { ensureLibraryFileReplica, resolveLibraryFileToLocalPath } from './bridge-library-files.js'
import { recordPrintDispatch } from './metrics.js'
import { markDispatchStartAttempted, recordDispatchEnqueued, recordDispatchStatus } from './dispatch-journal.js'

type DispatchStatus = PrintDispatchJob['status']
const MAX_UPLOAD_ATTEMPTS = 3
const UPLOAD_RETRY_BACKOFF_MS = [2_000, 5_000]
const ACTIVE_DISPATCH_STATUSES: readonly DispatchStatus[] = ['queued', 'uploading']
export const ACTIVE_DISPATCH_CONFLICT_MESSAGE = 'A print is already being dispatched to this printer. Wait for it to finish or cancel it first.'

interface DispatchJobState {
  id: string
  submissionId: string
  tenantId: string
  printerId: string
  printerName: string
  fileId: string
  fileName: string
  jobName: string
  plateName: string | null
  isMultiPlate: boolean
  fileSizeBytes: number
  sourceKind: '3mf' | 'gcode'
  projectFilamentChips: PrintDispatchJob['projectFilamentChips']
  localPath: string | null
  bridgeLibraryPath: string | null
  remoteName: string
  options: Omit<PrintFromLibrary, 'fileId' | 'printerId'>
  /**
   * Instance `identify_id`s to skip (resolved from the request's `skipObjects` object
   * ids at enqueue time), or null when the user deselected nothing. Sent as the start
   * command's `skip_objects` field (the primary mechanism — what Bambu Handy sends);
   * because older firmware ignores that field, runJob also arms a one-shot post-start
   * `skip_objects` fallback for the same ids.
   */
  postStartSkipObjectIds: number[] | null
  status: DispatchStatus
  progressMessage: string
  uploadAttempt: number
  uploadMaxAttempts: number
  uploadBytesSent: number
  uploadTotalBytes: number | null
  uploadPercent: number | null
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  cancelRequested: boolean
  /** Aborts the in-flight FTPS upload when the job is cancelled mid-transfer. Runtime-only. */
  abortController: AbortController | null
}

interface EnqueueLibraryPrintInput extends PrintFromLibrary {
  plateName?: string | null
  /** Whether the source 3MF contains more than one plate. Defaults to true. */
  isMultiPlate?: boolean
}

interface EnqueueSnapshotPrintInput extends Omit<EnqueueLibraryPrintInput, 'fileId'> {
  fileName: string
  snapshot: SnapshotLibraryFile
}

type PrintStartOptionSelection = Pick<
  PrintFromLibrary,
  | 'bedLevel'
  | 'vibrationCompensation'
  | 'flowCalibration'
  | 'firstLayerInspection'
  | 'timelapse'
  | 'filamentDynamicsCalibration'
  | 'nozzleOffsetCalibration'
>

const BAMBU_STUDIO_SEND_DIALOG_DEFAULTS = {
  vibrationCompensation: false,
  firstLayerInspection: true,
  filamentDynamicsCalibration: false
} as const

class PrintDispatcher {
  private readonly jobs = new Map<string, DispatchJobState>()
  private readonly printerQueues = new Map<string, Promise<void>>()
  // Printers with a dispatch being prepared but not yet inserted into `this.jobs`.
  // The active-dispatch check runs before several awaits (replica copy, 3MF parse),
  // so without a synchronous reservation two concurrent dispatches could both pass
  // the check during that window and double-print. Reserved synchronously, released
  // once the job is registered (or on failure).
  private readonly reservedPrinterIds = new Set<string>()

  hasActiveDispatchForPrinter(printerId: string): boolean {
    if (this.reservedPrinterIds.has(printerId)) return true
    return Array.from(this.jobs.values()).some((job) => job.printerId === printerId && ACTIVE_DISPATCH_STATUSES.includes(job.status))
  }

  /**
   * Refuse to dispatch through a bridge whose update status is incompatible
   * (protocol/runner/image out of date or unsupported). Such a bridge may still be
   * connected enough to report status, but it must not run printer-affecting actions
   * — an out-of-date bridge is exactly how a server fix fails to reach the print path.
   * The web surfaces the same status with an in-place "Update bridge" action; this is
   * the server-side backstop so a stale bridge cannot print even if the UI is bypassed.
   */
  async assertBridgeAllowsPrinting(bridgeId: string, tenantId: string): Promise<void> {
    // On a self-hosted bundle the bridge ships with the app and is lockstep by
    // construction, so its self-reported `updateStatus` must never gate printing
    // (see `resolveBridgeUpdateStatus`). A stale/blocking value there would
    // otherwise refuse dispatch before the job is even created — the print would
    // never appear in Jobs — for an "update" the operator has no way to apply.
    if (isSelfHostedDeployment()) return
    // `Bridge` is not in TENANT_SCOPED_MODELS, so we scope explicitly with the
    // caller's tenantId. rootPrisma is used deliberately (no auto-scoping needed for a
    // by-id lookup that already carries tenantId).
    const bridge = await rootPrisma.bridge.findFirst({
      where: { id: bridgeId, tenantId },
      select: { name: true, updateStatus: true }
    })
    const status = bridgeUpdateStatusSchema.safeParse(bridge?.updateStatus)
    if (status.success && bridgeUpdateBlocksPrinting(status.data)) {
      throw conflict(
        `Bridge "${bridge?.name ?? bridgeId}" needs to be updated before it can print (status: ${status.data}). Update the bridge and try again.`
      )
    }
  }

  assertNoActiveDispatchForPrinter(printerId: string): void {
    if (this.hasActiveDispatchForPrinter(printerId)) {
      throw conflict(ACTIVE_DISPATCH_CONFLICT_MESSAGE)
    }
  }

  async enqueueSnapshotPrint(
    input: EnqueueSnapshotPrintInput,
    loadedPrinter?: Awaited<ReturnType<typeof prisma.printer.findFirst>> | null
  ): Promise<PrintDispatchJob> {
    const printer = loadedPrinter ?? await prisma.printer.findFirst({ where: { id: input.printerId, tenantId: input.snapshot.tenantId } })
    const fileName = input.fileName
    const snapshot = input.snapshot
    if (!printer) throw new Error('Printer not found')
    if (printer.tenantId !== snapshot.tenantId) throw new Error('Printer not found')
    if (!printerManager.getPrinter(printer.id)) throw new Error('Printer not connected')
    if (!printer.bridgeId) throw new Error('Printer bridge assignment is required')
    await this.assertBridgeAllowsPrinting(printer.bridgeId, printer.tenantId)
    this.assertNoActiveDispatchForPrinter(printer.id)
    const blocked = printGuards.evaluate({ printerId: printer.id, source: 'dispatch' })
    if (blocked) throw new Error(blocked.reason ?? 'Print blocked by a plugin')
    if (!snapshot.ownerBridgeId) throw new Error('Library snapshots must be bridge-backed')
    // Reserve the printer now — no await has run since the active-dispatch check, so
    // this closes the prep-window race. Release once the job is registered or fails.
    this.reservedPrinterIds.add(printer.id)
    try {
      return await this.prepareAndEnqueueSnapshotJob(input, printer, snapshot, fileName)
    } finally {
      this.reservedPrinterIds.delete(printer.id)
    }
  }

  private async prepareAndEnqueueSnapshotJob(
    input: EnqueueSnapshotPrintInput,
    printer: NonNullable<Awaited<ReturnType<typeof prisma.printer.findFirst>>>,
    snapshot: EnqueueSnapshotPrintInput['snapshot'],
    fileName: string
  ): Promise<PrintDispatchJob> {
    if (!printer.bridgeId) throw new Error('Printer bridge assignment is required')
    if (!snapshot.ownerBridgeId) throw new Error('Library snapshots must be bridge-backed')
    const bridgeLibraryPath = await ensureLibraryFileReplica({
      tenantId: snapshot.tenantId,
      libraryFileId: snapshot.id,
      fileName: snapshot.name,
      sourceBridgeId: snapshot.ownerBridgeId,
      sourceStoredPath: snapshot.storedPath,
      sizeBytes: snapshot.sizeBytes,
      targetBridgeId: printer.bridgeId
    })
    const sourceKind = getPrintSourceKind(fileName)
    const localPath = sourceKind === '3mf'
      ? await resolveLibraryFileToLocalPath({
        ownerBridgeId: printer.bridgeId,
        storedPath: bridgeLibraryPath
      }).catch(() => null)
      : null
    const plateName = normalizePlateName(input.plateName)
    const isMultiPlate = input.isMultiPlate ?? true
    const parsedModel = printerModelSchema.safeParse(printer.model)
    const normalizedOptions = normalizePrintStartOptionsForPrinter(
      parsedModel.success ? parsedModel.data : 'unknown',
      input,
      printerManager.getStatus(printer.id)
    )
    const projectFilamentChips = await readLibraryProjectFilamentChips(snapshot).catch(() => [])
    // `ams_mapping` is indexed by project filament; entries for filaments the printed
    // plate does not use must be -1. Sending a real tray there makes the printer treat a
    // single-nozzle plate as a multi-nozzle job and run nozzle-offset calibration on a
    // nozzle the plate never uses (H2D error 0300-4010). Prune to the plate's actual
    // filaments; no-op for multi-filament plates and fail-safe if the plate can't be read.
    const amsMapping = await resolvePlateAmsMapping(sourceKind, localPath, input.plate, input.amsMapping)
    const postStartSkipObjectIds = await resolvePostStartSkipObjectIds(sourceKind, localPath, input.plate, input.skipObjects)

    const now = new Date()
    const target = getRemotePrintTarget(fileName, sourceKind, input.plate, plateName, { isMultiPlate })
    const job: DispatchJobState = {
      id: randomUUID(),
      submissionId: createDispatchSubmissionId(),
      tenantId: snapshot.tenantId,
      printerId: printer.id,
      printerName: printer.name,
      fileId: snapshot.id,
      fileName,
      jobName: target.subtaskName,
      plateName,
      isMultiPlate,
      fileSizeBytes: snapshot.sizeBytes,
      sourceKind,
      projectFilamentChips,
      localPath,
      bridgeLibraryPath,
      remoteName: target.remoteName,
      options: {
        useAms: input.useAms,
        bedLevel: normalizedOptions.bedLevel,
        vibrationCompensation: normalizedOptions.vibrationCompensation,
        flowCalibration: normalizedOptions.flowCalibration,
        firstLayerInspection: normalizedOptions.firstLayerInspection,
        timelapse: normalizedOptions.timelapse,
        filamentDynamicsCalibration: normalizedOptions.filamentDynamicsCalibration,
        nozzleOffsetCalibration: normalizedOptions.nozzleOffsetCalibration,
        allowIncompatibleFilament: input.allowIncompatibleFilament,
        allowPlateTypeMismatch: input.allowPlateTypeMismatch,
        currentPlateType: input.currentPlateType,
        currentNozzleDiameters: input.currentNozzleDiameters,
        plate: input.plate,
        amsMapping
      },
      postStartSkipObjectIds,
      status: 'queued',
      progressMessage: 'Waiting to send',
      uploadAttempt: 0,
      uploadMaxAttempts: MAX_UPLOAD_ATTEMPTS,
      uploadBytesSent: 0,
      uploadTotalBytes: null,
      uploadPercent: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      abortController: null
    }
    this.jobs.set(job.id, job)
    // Durable journal (best-effort): lets a restart reconcile this dispatch if it dies
    // before the print starts. See dispatch-journal.ts.
    void recordDispatchEnqueued({
      id: job.id,
      tenantId: job.tenantId,
      printerId: job.printerId,
      jobName: job.jobName,
      fileName: job.fileName,
      remoteName: job.remoteName
    })
    this.enqueueForPrinter(job)
    this.pruneOldJobs()
    return toDto(job)
  }

  list(tenantId: string): PrintDispatchJob[] {
    return Array.from(this.jobs.values())
      .filter((job) => job.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toDto)
  }

  async cancel(tenantId: string, jobId: string): Promise<PrintDispatchJob | null> {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) return null
    if (job.status === 'sent' || job.status === 'cancelled') {
      return toDto(job)
    }
    job.cancelRequested = true
    if (job.status === 'queued' || job.status === 'failed') {
      await this.cancelIdleJob(job, job.status === 'failed' ? 'Cancelled after failed dispatch' : 'Cancelled before upload')
    } else {
      // Mid-upload: abort the in-flight FTPS transfer instead of letting it run to
      // completion. runJob's cancellation handling then deletes any landed bytes.
      job.abortController?.abort()
      this.touch(job, 'Cancellation requested')
    }
    return toDto(job)
  }

  /**
   * Cancel a job that has not begun (or finished) an upload: best-effort cancel
   * its tracked PrintJob record, then mark the dispatch cancelled. Shared by the
   * user-initiated `cancel()` and shutdown `stop()`. Caller sets cancelRequested.
   */
  private async cancelIdleJob(job: DispatchJobState, message: string): Promise<void> {
    await cancelTrackedPrintJobRecord({
      jobId: job.id,
      printerId: job.printerId,
      jobName: job.jobName,
      metadata: this.buildPendingStartMetadata(job),
      startedAt: job.startedAt ?? job.createdAt
    }).catch(() => undefined)
    this.finish(job, 'cancelled', message)
  }

  /**
   * Graceful-shutdown drain. Cancels queued jobs and aborts in-flight uploads
   * (runJob then deletes any landed SD bytes and cancels the tracked record),
   * leaving 'sent' jobs — the live prints — untouched. Awaits the per-printer
   * queues so that cleanup runs within the caller's shutdown budget. Best-effort:
   * an exceeded budget force-exits, which is still better than abandoning silently.
   */
  async stop(): Promise<void> {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued') {
        job.cancelRequested = true
        await this.cancelIdleJob(job, 'Cancelled: server shutting down before upload')
      } else if (job.status === 'uploading') {
        job.cancelRequested = true
        job.abortController?.abort()
      }
    }
    await Promise.allSettled(Array.from(this.printerQueues.values()))
  }

  retry(tenantId: string, jobId: string): PrintDispatchJob | null {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) return null
    if (job.status !== 'failed') return toDto(job)
    job.status = 'queued'
    job.progressMessage = 'Waiting to retry'
    job.uploadAttempt = 0
    job.uploadBytesSent = 0
    job.uploadTotalBytes = null
    job.uploadPercent = null
    job.error = null
    job.startedAt = null
    job.finishedAt = null
    job.cancelRequested = false
    job.updatedAt = new Date()
    // Re-arm the journal row: back to queued and clear the rob-1 start boundary so the
    // retry's own start attempt re-establishes it.
    void recordDispatchStatus(job.id, 'queued', { error: null, finishedAt: null, clearStartAttempt: true })
    this.enqueueForPrinter(job)
    return toDto(job)
  }

  private enqueueForPrinter(job: DispatchJobState): void {
    const previous = this.printerQueues.get(job.printerId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.runJob(job))
    const tail = run.then(() => undefined, () => undefined)
    this.printerQueues.set(job.printerId, tail)
    tail.finally(() => {
      if (this.printerQueues.get(job.printerId) === tail) {
        this.printerQueues.delete(job.printerId)
      }
    })
  }

  private async runJob(job: DispatchJobState): Promise<void> {
    if (job.cancelRequested || job.status === 'cancelled') return
    const printer = printerManager.getPrinter(job.printerId)
    if (!printer) {
      this.finish(job, 'failed', 'Printer not connected', 'Printer not connected')
      return
    }

    job.status = 'uploading'
    job.startedAt = new Date()
    job.abortController = new AbortController()
    this.touch(job, 'Uploading to printer storage')
    void recordDispatchStatus(job.id, 'uploading')

    try {
      const artifact = await preparePrintArtifact(job)
      try {
        await this.uploadArtifactWithRetry(job, printer, artifact, job.abortController.signal)
      } finally {
        await artifact.cleanup()
      }
      if (job.cancelRequested) {
        // The upload finished before the cancel landed: the bytes are on the printer's
        // SD but no print was started, so delete them rather than leaking the file.
        await this.cleanupUploadedArtifact(job, printer)
        await cancelTrackedPrintJobRecord({
          printerId: job.printerId,
          jobId: job.id,
          jobName: job.jobName,
          metadata: this.buildPendingStartMetadata(job),
          startedAt: job.startedAt ?? job.createdAt
        })
        this.finish(job, 'cancelled', 'Cancelled after upload; print was not started')
        return
      }

      this.touch(job, 'Sending start command')
      try {
        // Durably cross the rob-1 boundary BEFORE publishing: once this commits, a
        // later crash treats the dispatch as "may have started" and never auto-cleans
        // its SD bytes. If it can't be recorded, abort before publish — a safe,
        // retryable failure beats risking a post-crash cleanup of a real print.
        await markDispatchStartAttempted(job.id)
      } catch (error) {
        console.error(`[dispatch] could not record start boundary for job ${job.id}; aborting before publish`, (error as Error).message)
        this.finish(job, 'failed', 'Could not record dispatch state before start', (error as Error).message)
        return
      }
      const printPayload = buildPrintStartPayload(job)
      // Log the full start command: when a print starts but misbehaves on-device
      // (wrong tray fetched, mapping-table errors like 0701-8012), the exact
      // mapping fields sent are the first thing support needs. No secrets ride
      // in this payload (file names, plate refs, and option flags only).
      console.log(`[dispatch] print start command for job ${job.id} (${job.printerName}): ${JSON.stringify(printPayload)}`)
      await registerPendingDispatchedPrintSource({
        printerId: job.printerId,
        jobId: job.id,
        localPath: job.localPath,
        sourceKind: job.sourceKind
      })
      // The start command below carries `skip_objects` (the primary skip mechanism),
      // but older firmware ignores that field, so also arm the post-start fallback
      // BEFORE publishing so a fast printer status cannot report the job started in
      // the gap. Safe to arm early: the hook only fires for this dispatch's own
      // tracked job id, and it stands down when the status shows the firmware
      // already honored the start-command skip.
      const skipObjectIds = job.postStartSkipObjectIds ?? []
      const disarmPostStartSkip = skipObjectIds.length > 0
        ? armPostStartObjectSkip({
          printerId: printer.id,
          printerModel: printer.model,
          dispatchJobId: job.id,
          jobName: job.jobName,
          objectIds: skipObjectIds
        })
        : null
      const startedJobId = await startTrackedPrintJob({
        jobId: job.id,
        printerId: job.printerId,
        jobName: job.jobName,
        fileName: job.fileName,
        metadata: this.buildPendingStartMetadata(job),
        publish: () => printerManager.publishCommand(printer.id, { print: printPayload })
      }).catch((error: unknown) => {
        disarmPostStartSkip?.()
        throw error
      })
      if (!startedJobId) {
        disarmPostStartSkip?.()
        console.warn(`[dispatch] MQTT start command failed for printer ${job.printerId} (job ${job.id}): printer disconnected before start`)
        this.finish(job, 'failed', 'Printer disconnected before start command', 'Printer disconnected')
        return
      }
      // Note: skipObjectIds are per-INSTANCE identify_ids, so their count can
      // exceed the number of deselected objects — keep the message countless.
      this.finish(
        job,
        'sent',
        skipObjectIds.length > 0
          ? 'Start command sent; deselected objects will be skipped once the print starts'
          : 'Start command sent'
      )
    } catch (error) {
      if (job.cancelRequested) {
        // The upload was aborted by a cancel mid-transfer. Any partial bytes that
        // reached the SD are orphaned, so best-effort delete them, then close out
        // the job as cancelled rather than failed.
        await this.cleanupUploadedArtifact(job, printer)
        await cancelTrackedPrintJobRecord({
          printerId: job.printerId,
          jobId: job.id,
          jobName: job.jobName,
          metadata: this.buildPendingStartMetadata(job),
          startedAt: job.startedAt ?? job.createdAt
        }).catch(() => undefined)
        this.finish(job, 'cancelled', 'Cancelled during upload; print was not started')
        return
      }
      console.error(`[dispatch] job ${job.id} failed for printer ${job.printerId}`, (error as Error).message)
      this.finish(job, 'failed', 'Dispatch failed', (error as Error).message)
    } finally {
      job.abortController = null
    }
  }

  /**
   * Best-effort removal of an upload's bytes from the printer SD after a cancel. The
   * file may be fully written (cancel landed post-upload) or partially written (cancel
   * aborted the transfer); either way it was never started, so it should not linger.
   */
  private async cleanupUploadedArtifact(job: DispatchJobState, printer: NonNullable<ReturnType<typeof printerManager.getPrinter>>): Promise<void> {
    try {
      await deletePrinterFile(printer, `/${job.remoteName}`)
    } catch (error) {
      console.warn(`[dispatch] failed to remove cancelled upload ${job.remoteName} from printer ${job.printerId}`, (error as Error).message)
    }
  }

  private touch(job: DispatchJobState, message: string): void {
    job.progressMessage = message
    job.updatedAt = new Date()
  }

  private finish(job: DispatchJobState, status: DispatchStatus, message: string, error: string | null = null): void {
    job.status = status
    job.progressMessage = message
    job.error = error
    job.finishedAt = new Date()
    job.updatedAt = job.finishedAt
    void recordDispatchStatus(job.id, status, { error, finishedAt: job.finishedAt })
    recordPrintDispatch({
      outcome: status === 'sent' ? 'success' : status === 'cancelled' ? 'cancelled' : 'failed',
      durationMs: job.finishedAt.getTime() - (job.startedAt ?? job.createdAt).getTime()
    })
  }

  private updateUploadProgress(job: DispatchJobState, bytesSent: number, totalBytes: number | null): void {
    const normalizedBytesSent = Math.max(0, Math.round(bytesSent))
    if (typeof totalBytes === 'number' && Number.isFinite(totalBytes) && totalBytes >= 0) {
      job.uploadBytesSent = Math.min(totalBytes, normalizedBytesSent)
      job.uploadTotalBytes = totalBytes
      job.uploadPercent = totalBytes > 0 ? Math.max(0, Math.min(100, (job.uploadBytesSent / totalBytes) * 100)) : null
      job.progressMessage = `Uploading ${formatBytes(job.uploadBytesSent)} of ${formatBytes(totalBytes)}`
    } else {
      job.uploadBytesSent = normalizedBytesSent
      job.uploadTotalBytes = null
      job.uploadPercent = null
      job.progressMessage = `Uploading ${formatBytes(job.uploadBytesSent)}`
    }
    job.updatedAt = new Date()
  }

  private async uploadArtifactWithRetry(job: DispatchJobState, printer: NonNullable<ReturnType<typeof printerManager.getPrinter>>, artifact: PrintArtifact, signal: AbortSignal): Promise<void> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      if (job.cancelRequested) throw new Error('Upload cancelled')
      const bridgeBackedUpload = artifact.bridgeLibraryPlatePath != null || job.bridgeLibraryPath != null
      job.uploadAttempt = attempt
      job.uploadMaxAttempts = MAX_UPLOAD_ATTEMPTS
      job.uploadBytesSent = 0
      job.uploadTotalBytes = artifact.sizeBytes
      job.uploadPercent = artifact.sizeBytes != null ? 0 : null
      this.touch(job, `${artifact.uploadMessage} (attempt ${attempt} of ${MAX_UPLOAD_ATTEMPTS})`)
      try {
        if (artifact.bridgeLibraryPlatePath && artifact.bridgeLibraryPlate != null) {
          const upload = await uploadBridgeLibraryPlateToPrinterPath(
            printer,
            artifact.bridgeLibraryPlatePath,
            artifact.bridgeLibraryPlate,
            `/${artifact.remoteName}`,
            (bytesSent, totalBytes) => {
              this.updateUploadProgress(job, bytesSent, totalBytes)
            },
            signal
          )
          const uploadedSizeBytes = upload.sizeBytes ?? job.uploadTotalBytes ?? artifact.sizeBytes
          if (uploadedSizeBytes != null) {
            job.fileSizeBytes = uploadedSizeBytes
            this.updateUploadProgress(job, uploadedSizeBytes, uploadedSizeBytes)
          }
        } else if (job.bridgeLibraryPath) {
          const upload = await uploadBridgeLibraryFileToPrinterPath(printer, job.bridgeLibraryPath, `/${artifact.remoteName}`, (bytesSent, totalBytes) => {
            this.updateUploadProgress(job, bytesSent, totalBytes)
          }, signal)
          const uploadedSizeBytes = upload.sizeBytes ?? job.uploadTotalBytes ?? artifact.sizeBytes
          if (uploadedSizeBytes != null) {
            job.fileSizeBytes = uploadedSizeBytes
            this.updateUploadProgress(job, uploadedSizeBytes, uploadedSizeBytes)
          }
        } else {
          if (!artifact.localPath) throw new Error('Upload artifact missing local source path')
          await uploadFileToPrinter(printer, artifact.localPath, artifact.remoteName, (bytesSent) => {
            this.updateUploadProgress(job, bytesSent, artifact.sizeBytes)
          }, { signal })
        }
        if (!bridgeBackedUpload && artifact.sizeBytes != null) {
          this.updateUploadProgress(job, artifact.sizeBytes, artifact.sizeBytes)
        }
        return
      } catch (error) {
        lastError = error as Error
        console.warn(`[dispatch] upload attempt ${attempt} of ${MAX_UPLOAD_ATTEMPTS} failed for printer ${job.printerId}`, lastError.message)
        if (attempt >= MAX_UPLOAD_ATTEMPTS || job.cancelRequested) break
        const backoff = UPLOAD_RETRY_BACKOFF_MS[attempt - 1] ?? UPLOAD_RETRY_BACKOFF_MS.at(-1) ?? 2_000
        job.error = lastError.message
        this.touch(job, `Upload failed; retrying in ${Math.round(backoff / 1000)}s (attempt ${attempt + 1} of ${MAX_UPLOAD_ATTEMPTS})`)
        await delay(backoff)
      }
    }
    throw lastError ?? new Error('Upload failed')
  }

  private buildPendingStartMetadata(job: DispatchJobState): PendingPrintJobSource {
    return {
      jobKind: 'file',
      jobId: job.id,
      printerFilePath: normalizeExactPrinterFilePath(`/${job.remoteName}`),
      fileId: job.fileId,
      fileName: job.fileName,
      fileSizeBytes: job.fileSizeBytes,
      sourceKind: job.sourceKind,
      plate: job.options.plate,
      useAms: job.options.useAms,
      bedLevel: job.options.bedLevel !== 'off',
      amsMapping: job.options.amsMapping ?? null,
      calibrationOption: null
    }
  }


  private pruneOldJobs(): void {
    const finished = Array.from(this.jobs.values())
      .filter((job) => job.finishedAt)
      .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))
    for (const job of finished.slice(100)) {
      this.jobs.delete(job.id)
    }
  }
}

interface PrintArtifact {
  localPath: string | null
  remoteName: string
  sizeBytes: number | null
  uploadMessage: string
  bridgeLibraryPlatePath: string | null
  bridgeLibraryPlate: number | null
  cleanup: () => Promise<void>
}

async function preparePrintArtifact(job: DispatchJobState): Promise<PrintArtifact> {
  const target = getRemotePrintTarget(job.fileName, job.sourceKind, job.options.plate, job.plateName, { isMultiPlate: job.isMultiPlate })
  if (job.sourceKind === 'gcode') {
    if (job.bridgeLibraryPath) {
      return {
        localPath: null,
        remoteName: target.remoteName,
        sizeBytes: job.fileSizeBytes,
        uploadMessage: 'Uploading G-code to printer storage',
        bridgeLibraryPlatePath: null,
        bridgeLibraryPlate: null,
        cleanup: async () => undefined
      }
    }
    if (!job.localPath) throw new Error('Dispatch artifact missing local source path')
    const stats = await stat(job.localPath)
    return {
      localPath: job.localPath,
      remoteName: target.remoteName,
      sizeBytes: stats.size,
      uploadMessage: 'Uploading G-code to printer storage',
      bridgeLibraryPlatePath: null,
      bridgeLibraryPlate: null,
      cleanup: async () => undefined
    }
  }

  if (job.bridgeLibraryPath) {
    return {
      localPath: null,
      remoteName: target.remoteName,
      sizeBytes: null,
      uploadMessage: `Uploading plate ${job.options.plate} 3MF to printer storage`,
      bridgeLibraryPlatePath: job.bridgeLibraryPath,
      bridgeLibraryPlate: job.options.plate,
      cleanup: async () => undefined
    }
  }

  if (!job.localPath) throw new Error('Dispatch artifact missing local source path')

  const tempDir = await mkdtemp(path.join(tmpdir(), 'bambu-plate-'))
  const tempPath = path.join(tempDir, target.remoteName)
  try {
    await createSinglePlateThreeMf(job.localPath, tempPath, job.options.plate)
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`Failed to create plate ${job.options.plate} 3MF: ${(error as Error).message}`)
  }
  return {
    localPath: tempPath,
    remoteName: target.remoteName,
    sizeBytes: (await stat(tempPath)).size,
    uploadMessage: `Uploading plate ${job.options.plate} 3MF to printer storage`,
    bridgeLibraryPlatePath: null,
    bridgeLibraryPlate: null,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

interface RemotePrintTarget {
  remoteName: string
  param: string
  subtaskName: string
}

/**
 * The identifiers and option flags that shape a Bambu `project_file` MQTT
 * print-start command. Callers supply their own `subtaskName`/`useAms` because
 * those differ by entry point (e.g. printer-storage prints use the resolved
 * job name; reprints use the plate subtask name).
 */
export interface ProjectFilePrintCommandInput {
  remoteName: string
  param: string
  subtaskName: string
  submissionId: string
  bedLevel: PrintOnOffAutoMode
  flowCalibration: PrintOnOffAutoMode
  vibrationCompensation: boolean
  firstLayerInspection: boolean
  filamentDynamicsCalibration: boolean
  nozzleOffsetCalibration: PrintNozzleOffsetCalibrationMode
  timelapse: boolean
  useAms: boolean
  amsMapping?: number[] | null
  /**
   * Instance `identify_id`s to exclude from the print, sent as the payload's
   * `skip_objects` array (what Bambu Handy sends; there is an is_support_partskip
   * capability bit, and firmware without it ignores the field — callers keep the
   * post-start mid-print skip as a fallback). Omitted entirely when empty.
   */
  skipObjects?: number[] | null
}

/**
 * Marks an `ams_mapping_2` entry as unmapped (BambuStudio uses `0xff` for both
 * fields). Distinguished from an external virtual tray (`ams_id` 254/255) by the
 * `slot_id`: virtual trays carry slot 0, unmapped entries carry 0xff.
 */
const AMS_MAPPING_2_UNSET = 0xff

/**
 * The v2 `ams_mapping_2` entry for a legacy global tray index. BambuStudio sends
 * this `{ams_id, slot_id}` form alongside the legacy index array on every print
 * (see `SelectMachineDialog::get_ams_mapping_result`), and H2C (Vortek rack)
 * firmware requires it to build its runtime AMS mapping table: a legacy-only
 * command starts printing but fails with 0701-8012 ("Failed to get AMS mapping
 * table") at the first filament change that actually fetches from the AMS.
 * Unused entries (-1 from plate pruning) become 0xff/0xff; external virtual
 * trays (254/255) keep their id with slot 0, matching BambuStudio.
 *
 * The AMS Lite Mixed band (24-27) is deliberately sent as unset: those indices
 * are ambiguous in reverse (`trayIndexToAmsSlot` reads them as regular unit 6),
 * and a v2 pair that contradicts the correct legacy index would be worse than
 * none — BambuStudio itself pairs real `ams_mapping` values with 0xff/0xff v2
 * entries in its SD-resend invalid case, so firmware tolerates the combination.
 */
function amsMapping2Entry(trayIndex: number): { ams_id: number; slot_id: number } {
  const liteMixedBand = trayIndex >= AMS_LITE_MIXED_TRAY_INDEX_OFFSET && trayIndex < AMS_LITE_MIXED_TRAY_INDEX_OFFSET + 4
  const slot = liteMixedBand ? null : trayIndexToAmsSlot(trayIndex)
  if (!slot) return { ams_id: AMS_MAPPING_2_UNSET, slot_id: AMS_MAPPING_2_UNSET }
  return { ams_id: slot.amsId, slot_id: slot.slotId ?? 0 }
}

/**
 * Build the Bambu `project_file` MQTT print-start command. The single source
 * for this payload shape — the dispatcher and the printer-storage / reprint
 * routes all go through here so every print path sends an identical command.
 * Object skipping rides in the payload's `skip_objects` array (see
 * {@link ProjectFilePrintCommandInput.skipObjects}).
 *
 * The AMS mapping is sent in both wire forms, mirroring what BambuStudio's
 * SD-card resend flow (the closest analog to our upload-then-start dispatch)
 * sends to every model: the legacy `ams_mapping` global-tray-index array plus
 * the v2 `ams_mapping_2` unit/slot pairs (see {@link amsMapping2Entry}).
 */
export function buildProjectFilePrintCommand(input: ProjectFilePrintCommandInput): Record<string, unknown> {
  const printPayload: Record<string, unknown> = {
    command: 'project_file',
    param: input.param,
    url: `ftp:///${input.remoteName}`,
    file: input.remoteName,
    md5: '',
    bed_type: 'auto',
    timelapse: input.timelapse,
    bed_leveling: isPrintOnOffAutoModeEnabled(input.bedLevel),
    auto_bed_leveling: resolvePrintOnOffAutoModeFlag(input.bedLevel),
    flow_cali: isPrintOnOffAutoModeEnabled(input.flowCalibration),
    auto_flow_cali: resolvePrintOnOffAutoModeFlag(input.flowCalibration),
    vibration_cali: input.vibrationCompensation,
    layer_inspect: input.firstLayerInspection,
    use_ams: input.useAms,
    cfg: '0',
    extrude_cali_flag: input.filamentDynamicsCalibration ? 1 : 0,
    extrude_cali_manual_mode: 0,
    nozzle_offset_cali: resolveNozzleOffsetCalibrationFlag(input.nozzleOffsetCalibration),
    subtask_name: input.subtaskName,
    profile_id: '0',
    project_id: input.submissionId,
    subtask_id: input.submissionId,
    task_id: input.submissionId
  }
  if (input.amsMapping && input.amsMapping.length > 0) {
    printPayload.ams_mapping = input.amsMapping
    printPayload.ams_mapping_2 = input.amsMapping.map(amsMapping2Entry)
  }
  if (input.skipObjects && input.skipObjects.length > 0) {
    printPayload.skip_objects = input.skipObjects
  }
  return printPayload
}

function buildPrintStartPayload(job: DispatchJobState): Record<string, unknown> {
  const target = getRemotePrintTarget(job.fileName, job.sourceKind, job.options.plate, job.plateName, { isMultiPlate: job.isMultiPlate })
  return buildProjectFilePrintCommand({
    remoteName: target.remoteName,
    param: target.param,
    subtaskName: target.subtaskName,
    submissionId: job.submissionId,
    bedLevel: job.options.bedLevel,
    flowCalibration: job.options.flowCalibration,
    vibrationCompensation: job.options.vibrationCompensation,
    firstLayerInspection: job.options.firstLayerInspection,
    filamentDynamicsCalibration: job.options.filamentDynamicsCalibration,
    nozzleOffsetCalibration: job.options.nozzleOffsetCalibration,
    timelapse: job.options.timelapse,
    useAms: job.options.useAms,
    amsMapping: job.options.amsMapping,
    skipObjects: job.postStartSkipObjectIds
  })
}

/**
 * Resolve the AMS mapping actually sent to the printer, pruned to the filaments the
 * printed plate uses. Only applies to bridge-resolvable 3MF sources (we read the plate's
 * `filament_ids` from the artifact); everything else passes through unchanged.
 */
async function resolvePlateAmsMapping(
  sourceKind: '3mf' | 'gcode',
  localPath: string | null,
  plate: number | null,
  amsMapping: number[] | undefined
): Promise<number[] | undefined> {
  if (!amsMapping || amsMapping.length === 0 || sourceKind !== '3mf' || !localPath || plate == null) return amsMapping
  const usedFilamentIndices = await readPlateUsedFilamentIndices(localPath, plate)
  return prunePlateAmsMapping(amsMapping, usedFilamentIndices)
}

/**
 * Resolve the request's deselected plate objects (`skipObjects`, Bambu `object_id`s from the
 * plates index) into the instance `identify_id`s the firmware keys object skipping on (both
 * the start command's `skip_objects` field and the mid-print command), read from the source
 * 3MF's `Metadata/model_settings.config`.
 *
 * Unlike the AMS-mapping prune above, this is NOT fail-safe-passthrough: the user explicitly
 * deselected objects, so printing them anyway would violate intent and waste material. Any
 * unresolvable selection (unreadable file, unknown object id, file without identify_ids, or a
 * selection that would skip every object) rejects the dispatch with a clear error instead.
 * Returns null when nothing was deselected.
 */
async function resolvePostStartSkipObjectIds(
  sourceKind: '3mf' | 'gcode',
  localPath: string | null,
  plate: number,
  skipObjects: number[] | undefined
): Promise<number[] | null> {
  if (!skipObjects || skipObjects.length === 0) return null
  if (sourceKind !== '3mf') {
    throw new Error('Object skipping is only available for sliced 3MF files')
  }
  const modelSettingsXml = localPath
    ? await readEntry(localPath, 'Metadata/model_settings.config')
      .then((buffer) => buffer.toString('utf8'))
      .catch(() => null)
    : null
  if (!modelSettingsXml) {
    throw new Error('Could not read the file to resolve the deselected objects. Try again, or print without deselecting objects.')
  }
  const mapped = plateSkipIdentifyIdsFromModelSettingsXml(modelSettingsXml, plate, new Set(skipObjects))
  if (mapped.unmatchedObjectIds.length > 0 || mapped.identifyIds.length === 0) {
    throw new Error('Some deselected objects could not be matched on the selected plate. Re-open the print dialog and try again.')
  }
  if (mapped.identifyIds.length >= mapped.plateInstanceCount) {
    throw new Error('Cannot skip every object on the plate. Keep at least one object selected.')
  }
  return mapped.identifyIds
}

/**
 * The 0-based project-filament indices a plate uses, read from the 3MF's
 * `Metadata/plate_{plate}.json` `filament_ids`. Returns an empty set on any read/parse
 * failure so callers fall back to leaving the mapping untouched.
 */
async function readPlateUsedFilamentIndices(localPath: string, plate: number): Promise<ReadonlySet<number>> {
  try {
    const buffer = await readEntry(localPath, `Metadata/plate_${plate}.json`)
    const parsed = JSON.parse(buffer.toString('utf8')) as { filament_ids?: unknown }
    const ids = Array.isArray(parsed.filament_ids)
      ? parsed.filament_ids.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
      : []
    return new Set(ids)
  } catch {
    return new Set()
  }
}

/**
 * -1 out the AMS-mapping entries for filaments the plate does not use, then drop trailing
 * -1s. `ams_mapping[i]` is the tray for project filament `i` (0-based). A plate that uses
 * only filament 0 of a 3-filament project yields `[tray]` rather than `[tray, x, y]`, so
 * the printer treats it as the single-nozzle job it is. Empty `usedFilamentIndices` (read
 * failed) or no matching used entry leaves the mapping unchanged — never break a print.
 */
export function prunePlateAmsMapping(amsMapping: number[], usedFilamentIndices: ReadonlySet<number>): number[] {
  if (usedFilamentIndices.size === 0) return amsMapping
  const pruned = amsMapping.map((value, index) => (usedFilamentIndices.has(index) ? value : -1))
  let lastUsed = -1
  for (let index = 0; index < pruned.length; index += 1) {
    const value = pruned[index]
    if (value !== undefined && value >= 0) lastUsed = index
  }
  return lastUsed === -1 ? amsMapping : pruned.slice(0, lastUsed + 1)
}

export function getPrintSourceKind(fileName: string): '3mf' | 'gcode' {
  return fileName.toLowerCase().endsWith('.gcode.3mf') ? '3mf' : 'gcode'
}

function createDispatchSubmissionId(): string {
  return String((Date.now() % 2_147_483_647) || 1)
}

export function getRemotePrintTarget(
  fileName: string,
  sourceKind: '3mf' | 'gcode',
  plate: number,
  plateName?: string | null,
  options?: { isMultiPlate?: boolean }
): RemotePrintTarget {
  if (sourceKind === 'gcode') {
    const remoteName = sanitizeRemoteName(fileName)
    return { remoteName, param: remoteName, subtaskName: stripPrintableExtension(remoteName) }
  }
  const base = stripPrintableExtension(sanitizeRemoteName(fileName))
  // A single-plate 3MF already identifies its plate through the file name (e.g. a
  // sliced "Best Shot Golf - Plate 4" output). Appending the plate label again would
  // duplicate it, so only multi-plate projects get the plate label to disambiguate
  // which plate is being printed.
  if (options?.isMultiPlate === false) {
    return { remoteName: `${base}.gcode.3mf`, param: `Metadata/plate_${plate}.gcode`, subtaskName: base }
  }
  const plateLabel = normalizePlateName(plateName) ?? `plate_${plate}`
  const subtaskName = `${base} - ${plateLabel}`
  const remoteName = `${sanitizeRemoteName(subtaskName)}.gcode.3mf`
  return { remoteName, param: `Metadata/plate_${plate}.gcode`, subtaskName }
}

export function resolveNozzleOffsetCalibrationFlag(mode: PrintNozzleOffsetCalibrationMode): 0 | 1 | 2 {
  switch (mode) {
    case 'on':
      return 1
    case 'auto':
      return 2
    case 'off':
    default:
      return 0
  }
}

export function resolvePrintOnOffAutoModeFlag(mode: PrintOnOffAutoMode): 0 | 1 | 2 {
  switch (mode) {
    case 'on':
      return 1
    case 'auto':
      return 2
    case 'off':
    default:
      return 0
  }
}

export function isPrintOnOffAutoModeEnabled(mode: PrintOnOffAutoMode): boolean {
  return mode === 'on'
}

export function normalizePrintStartOptionsForPrinter(
  model: PrinterModel,
  options: PrintStartOptionSelection,
  status?: (Pick<PrinterStatus, 'printOptions'> & { printStartOptions?: PrinterStatus['printStartOptions'] }) | null
): PrintStartOptionSelection {
  const printStartOptions = getPrinterPrintStartOptions(model, status)
  return {
    bedLevel: normalizePrintOnOffAutoMode(
      options.bedLevel,
      printStartOptions.bedLevel.supported,
      printStartOptions.bedLevel.autoSupported
    ),
    vibrationCompensation: BAMBU_STUDIO_SEND_DIALOG_DEFAULTS.vibrationCompensation,
    flowCalibration: normalizePrintOnOffAutoMode(
      options.flowCalibration,
      printStartOptions.flowCalibration.supported,
      printStartOptions.flowCalibration.autoSupported
    ),
    firstLayerInspection: printStartOptions.firstLayerInspection.supported && options.firstLayerInspection,
    timelapse: printStartOptions.timelapse.supported && options.timelapse,
    filamentDynamicsCalibration: BAMBU_STUDIO_SEND_DIALOG_DEFAULTS.filamentDynamicsCalibration,
    nozzleOffsetCalibration: printStartOptions.nozzleOffsetCalibration.supported ? options.nozzleOffsetCalibration : 'off'
  }
}

function normalizePrintOnOffAutoMode(
  mode: PrintOnOffAutoMode,
  supported: boolean,
  autoSupported: boolean
): PrintOnOffAutoMode {
  if (!supported) return 'off'
  if (mode === 'auto' && !autoSupported) return 'on'
  return mode
}

function stripPrintableExtension(fileName: string): string {
  return fileName.replace(/\.gcode\.3mf$/i, '').replace(/\.(3mf|gcode)$/i, '')
}

function normalizePlateName(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ')
  return normalized ? normalized : null
}

function toDto(job: DispatchJobState): PrintDispatchJob {
  return {
    id: job.id,
    printJobId: job.id,
    printerId: job.printerId,
    printerName: job.printerName,
    fileId: job.fileId,
    fileName: job.fileName,
    jobName: job.jobName,
    fileSizeBytes: job.fileSizeBytes,
    sourceKind: job.sourceKind,
    projectFilamentChips: job.projectFilamentChips,
    plate: job.options.plate,
    plateName: job.plateName,
    useAms: job.options.useAms,
    bedLevel: job.options.bedLevel,
    amsMapping: job.options.amsMapping ?? null,
    status: job.status,
    progressMessage: job.progressMessage,
    uploadAttempt: job.uploadAttempt,
    uploadMaxAttempts: job.uploadMaxAttempts,
    uploadBytesSent: job.uploadBytesSent,
    uploadTotalBytes: job.uploadTotalBytes,
    uploadPercent: job.uploadPercent,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    cancelRequested: job.cancelRequested
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Bambu firmware rejects names containing path separators or non-ASCII chars; FAT
 * also reserves `<>:"|?*`. Everything else (brackets, +, ', etc.) is kept — Bambu
 * Studio itself sends names like "Mount (landscape).gcode.3mf" to printers.
 */
export function sanitizeRemoteName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '')
  return base.trim().replace(/[<>:"|?*]/g, '_').replace(/[^\x20-\x7e]+/g, '_')
}

export const printDispatcher = new PrintDispatcher()
