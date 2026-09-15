/**
 * In-memory orchestration for server-side slicing jobs.
 *
 * The API queues and scopes work while a separate slicer runtime owns
 * BambuStudio CLI execution. Completed artifacts are persisted back into the
 * library: {@link persistLibraryFileFromLocalPath} for the sliced file and
 * {@link persistHistoryThumbnailFromLibrary} for its history thumbnail.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  CreateSlicingJob,
  PreservedSliceSettings,
  SlicingJob,
  SlicingJobStatus,
  SlicingOutputLine,
  SlicingMetadata
} from '@printstream/shared'
import { isActiveSlicingJob, isDirectPrintableFileName, isFilamentTrackSwitchReady } from '@printstream/shared'
import { env } from './env.js'
import { conflict, HttpError, notFound } from './http-error.js'
import { persistHistoryThumbnailFromLibrary } from './job-history-thumbnail-source.js'
import { discardHiddenSlicedOutput, persistLibraryFileFromLocalPath } from './library-files.js'
import { printerManager } from './printer-manager.js'
import { authorSliceSettingsIntoProject } from './slice-settings-authoring.js'
import { preserveSlicedProject } from './sliced-project-preservation.js'
import { deletePrintJobThumbnail } from './print-job-thumbnails.js'
import { authorProjectMachineFromProfile } from './save-retarget.js'
import { SlicerServiceError, slicerClient, type SlicerCapabilities } from './slicer-client.js'
import {
  INITIAL_SLICER_CONTACT,
  UNKNOWN_JOB_GRACE_MS,
  UNREACHABLE_GRACE_MS,
  nextSlicerContact,
  slicerContactGiveUpMessage,
  slicerContactHeartbeat,
  type SlicerContactState
} from './slicer-contact.js'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, embedPlateThumbnails, rekeyReplacedObjectOverrides } from './three-mf.js'
import { healUnweldedThreeMfMeshes } from './three-mf-mesh-weld.js'
import { resolveSceneEditImports } from './import-store.js'
import type { ResolvedSlicingPresetFile } from './slicing-presets.js'
import { withWorkspaceRequestContext, type RequestWorkspaceSummary } from './workspace-context.js'
import { broadcastSlicingChanged } from './ws-resource-events.js'
import { clientSessions } from './client-sessions.js'
import { recordSliceJob } from './metrics.js'
import { prisma } from './prisma.js'
import { resolveLibraryFileToLocalPath } from './bridge-library-files.js'
import { resolvePinnedContentBase, type LibraryContentBase } from './library-content-base.js'
import { slicingExecutionScheduler, type SlicingExecutionTier } from './slicing-execution-scheduler.js'
import {
  lookupSlicingResultCache,
  storeSlicingResultCache,
  type SliceCacheHit,
  type SliceCacheLookupInput
} from './slice-cache.js'

const DEFAULT_SLICING_PROGRESS_POLL_INTERVAL_MS = 750
/** How long a finished job stays in `listActive`: see its doc for who relies on this. */
const ACTIVE_LIST_RECENT_WINDOW_MS = 5 * 60_000
const DEFAULT_SLICING_PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_SLICING_STATE_FILE = path.resolve(path.dirname(env.LIBRARY_DIR), 'slicing-jobs-state.json')
const INTERRUPTED_SLICING_MESSAGE = 'Slicing was interrupted by a server restart. Slice again to retry.'

interface SlicingJobState {
  id: string
  workspaceId: string
  workspace: RequestWorkspaceSummary
  executionTier: Exclude<SlicingExecutionTier, 'anonymous'>
  sourceFileId: string
  sourceFileName: string
  sourcePath: string
  targetBridgeId: string | null
  executionPrinterModel: string | null
  outputFileId: string | null
  outputFileName: string | null
  thumbnailPath: string | null
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingPresetFile[]
  status: SlicingJobStatus
  queuePosition: number | null
  slicerName: string | null
  metadata: SlicingMetadata
  output: SlicingOutputLine[]
  error: string | null
  createdAt: Date
  updatedAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  cancelRequested: boolean
  controller: AbortController | null
  activeSlicerJobId: string | null
  /**
   * Set by the live-progress watchdog when it aborts the slice because the slicer stopped
   * acknowledging the job. Distinguishes that abort from a user Cancel, which shares the
   * controller. In-memory only, a lost slice is never resumed, so it need not survive a restart.
   */
  lostReason: string | null
  /** Deterministic identity computed before queueing; null when this run is not cacheable. */
  cacheKey: string | null
  /** Live switch fact included in `cacheKey`, retained so a queued run cannot store under stale facts. */
  cacheHasFilamentTrackSwitch: boolean | null
  /** A cache probe bypasses the execution scheduler until it proves the slice must run. */
  cacheLookupPending: boolean
}

interface PersistedSlicingJobsState {
  jobs: PersistedSlicingJobState[]
}

interface PersistedSlicingJobState {
  id: string
  workspaceId: string
  workspace: RequestWorkspaceSummary
  executionTier?: Exclude<SlicingExecutionTier, 'anonymous'>
  sourceFileId: string
  sourceFileName: string
  sourcePath: string
  targetBridgeId: string | null
  executionPrinterModel: string | null
  outputFileId: string | null
  outputFileName: string | null
  thumbnailPath: string | null
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingPresetFile[]
  status: SlicingJobStatus
  slicerName: string | null
  metadata: SlicingMetadata
  output: SlicingOutputLine[]
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  cancelRequested: boolean
  cacheKey?: string | null
  cacheHasFilamentTrackSwitch?: boolean | null
}

export type PersistSlicedArtifact = typeof persistLibraryFileFromLocalPath
export type PersistSlicingHistoryThumbnail = typeof persistHistoryThumbnailFromLibrary
export type PreserveSlicedProject = typeof preserveSlicedProject
export type AuthorSliceSettings = typeof authorSliceSettingsIntoProject
export type ResolveSlicingSource = (input: {
  sourceFileId: string
  sourcePath: string
  workspaceId: string
  contentBase?: LibraryContentBase | null
  preparedSource?: CreateSlicingJob['preparedSource'] | null
}) => Promise<string>
export type LookupSlicingResultCache = typeof lookupSlicingResultCache
export type StoreSlicingResultCache = typeof storeSlicingResultCache
export type ResolveSlicerCapabilities = () => Promise<SlicerCapabilities>

/**
 * Resolve the local path to slice from. Prefers the persisted local/_bridge-cache
 * copy while it still exists (the common case, no behavior change); otherwise
 * re-resolves and re-fetches from the current library file, so a job that
 * outlived an API restart (fresh volume) or a source delete/replace doesn't fail
 * with an opaque ENOENT. Throws a clear, requeue-able message when the source can
 * no longer be resolved. Runs inside the job's workspace context (run() wraps it),
 * so the workspace-scoped client applies.
 *
 * A job carrying a browser-prepared source re-resolves that immutable hidden snapshot first. It
 * must never fall back to `sourceFileId`, which deliberately remains the ORIGINAL project's
 * lineage and may have changed since the browser authored the staged bytes. The proof is rebound
 * to both that lineage and the independent configuration-base pin before its snapshot is used.
 *
 * A job carrying a `contentBase` re-resolves through THAT pin, never the file's current content:
 * its `sceneEdit` is a diff against the pinned bytes, so re-fetching the head here would re-apply
 * an edit an intervening save already baked in: the same corruption the pin exists to stop, only
 * reached through the cache-eviction path instead of the enqueue path.
 */
export async function resolveSlicingSourcePath(input: {
  sourceFileId: string
  sourcePath: string
  workspaceId: string
  contentBase?: LibraryContentBase | null
  preparedSource?: CreateSlicingJob['preparedSource'] | null
}): Promise<string> {
  try {
    await stat(input.sourcePath)
    return input.sourcePath
  } catch {
    // The cached copy is gone; re-resolve from the pinned base (or the library file) below.
  }
  if (input.preparedSource) {
    const prepared = await prisma.preparedSlicingSource.findFirst({
      where: {
        id: input.preparedSource.id,
        workspaceId: input.workspaceId,
        sourceFileId: input.sourceFileId,
        configurationBaseFileId: input.contentBase?.fileId ?? input.sourceFileId,
        configurationBaseVersionId: input.contentBase?.versionId ?? '',
        contractVersion: input.preparedSource.contractVersion,
        libraryFile: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          hidden: true,
          origin: 'snapshot',
          snapshotKey: { not: null }
        }
      },
      select: { libraryFile: { select: { ownerBridgeId: true, storedPath: true } } }
    })
    if (!prepared) {
      throw new Error('The browser-prepared project for this slice is no longer available; re-open it and slice again.')
    }
    try {
      return await resolveLibraryFileToLocalPath(prepared.libraryFile)
    } catch (error) {
      console.warn(
        `[slicing] browser-prepared source ${input.preparedSource.id} could not be retrieved:`,
        error instanceof Error ? error.message : error
      )
      throw new Error('The browser-prepared project could not be retrieved from its bridge; try again once the bridge is online.')
    }
  }
  if (input.contentBase) {
    try {
      return await resolveLibraryFileToLocalPath(await resolvePinnedContentBase(input.workspaceId, input.contentBase))
    } catch (error) {
      // Logged rather than swallowed: the pin names either a version that was swept or a bridge
      // that is offline, and the requeue-able message below cannot say which.
      console.warn('[slicing] pinned content base could not be resolved:', error instanceof Error ? error.message : error)
      throw new Error('The project this slice was composed from is no longer available; re-open it and slice again.')
    }
  }
  const row = await prisma.libraryFile.findUnique({
    where: { id: input.sourceFileId },
    select: { ownerBridgeId: true, storedPath: true }
  })
  if (!row) throw new Error('Slicing source is no longer available; re-slice it from the library.')
  try {
    return await resolveLibraryFileToLocalPath(row)
  } catch {
    throw new Error('Slicing source could not be retrieved from its bridge; try again once the bridge is online.')
  }
}

export class SlicingJobs {
  private readonly jobs = new Map<string, SlicingJobState>()
  private readonly progressPollIntervalMs: number
  private readonly progressHeartbeatIntervalMs: number
  /** Watchdog graces; see `slicer-contact.ts`. Overridable so tests need not wait out the real ones. */
  private readonly lostUnknownGraceMs: number
  private readonly lostUnreachableGraceMs: number
  private readonly persistencePath: string | null
  private readonly persistArtifact: PersistSlicedArtifact
  private readonly persistThumbnail: PersistSlicingHistoryThumbnail
  private readonly preserveProject: PreserveSlicedProject
  private readonly authorSliceSettings: AuthorSliceSettings
  private readonly resolveSource: ResolveSlicingSource
  private readonly lookupResultCache: LookupSlicingResultCache | null
  private readonly storeResultCache: StoreSlicingResultCache
  private readonly resolveSlicerCapabilities: ResolveSlicerCapabilities
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistPromise: Promise<void> = Promise.resolve()

  constructor(options?: {
    progressPollIntervalMs?: number
    progressHeartbeatIntervalMs?: number
    lostUnknownGraceMs?: number
    lostUnreachableGraceMs?: number
    persistState?: boolean
    stateFilePath?: string
    persistArtifact?: PersistSlicedArtifact
    persistThumbnail?: PersistSlicingHistoryThumbnail
    preserveProject?: PreserveSlicedProject
    authorSliceSettings?: AuthorSliceSettings
    resolveSource?: ResolveSlicingSource
    /** Null disables cache probes; tests default to disabled unless they opt into the seam. */
    lookupResultCache?: LookupSlicingResultCache | null
    storeResultCache?: StoreSlicingResultCache
    resolveSlicerCapabilities?: ResolveSlicerCapabilities
  }) {
    this.progressPollIntervalMs = options?.progressPollIntervalMs ?? DEFAULT_SLICING_PROGRESS_POLL_INTERVAL_MS
    this.progressHeartbeatIntervalMs = options?.progressHeartbeatIntervalMs ?? DEFAULT_SLICING_PROGRESS_HEARTBEAT_INTERVAL_MS
    this.lostUnknownGraceMs = options?.lostUnknownGraceMs ?? UNKNOWN_JOB_GRACE_MS
    this.lostUnreachableGraceMs = options?.lostUnreachableGraceMs ?? UNREACHABLE_GRACE_MS
    this.persistArtifact = options?.persistArtifact ?? persistLibraryFileFromLocalPath
    this.persistThumbnail = options?.persistThumbnail ?? persistHistoryThumbnailFromLibrary
    this.preserveProject = options?.preserveProject ?? preserveSlicedProject
    this.authorSliceSettings = options?.authorSliceSettings ?? authorSliceSettingsIntoProject
    this.resolveSource = options?.resolveSource ?? resolveSlicingSourcePath
    this.lookupResultCache = options?.lookupResultCache !== undefined
      ? options.lookupResultCache
      : env.NODE_ENV === 'test' ? null : lookupSlicingResultCache
    this.storeResultCache = options?.storeResultCache ?? storeSlicingResultCache
    this.resolveSlicerCapabilities = options?.resolveSlicerCapabilities ?? (() => slicerClient.capabilities())

    const persistState = options?.persistState ?? env.NODE_ENV !== 'test'
    this.persistencePath = persistState ? (options?.stateFilePath ?? DEFAULT_SLICING_STATE_FILE) : null
    this.hydrateFromDisk()
    this.pumpQueue()
    this.recomputeQueuePositions()
  }

  /**
   * The workspace's jobs, newest first.
   *
   * A FINISHED job comes back without the engine's raw stdout/stderr, only the `system` lines
   * that are its user-facing status. This response is polled by every open tab and grows with
   * history, and the engine log dwarfs everything else on a job: 185 jobs made it 1.3 MB, 1.07 MB
   * of which was log no surface renders (the web reads a finished job's outcome from its last
   * system line). The complete log stays on `GET /jobs/:id`. Active jobs keep everything, their
   * progress frames ARE stdout.
   */
  list(workspaceId: string): SlicingJob[] {
    this.recomputeQueuePositions()
    return Array.from(this.jobs.values())
      .filter((job) => job.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((job) => (isActiveSlicingJobState(job) ? toDto(job) : toFinishedListDto(job)))
  }

  /**
   * The workspace's ACTIVE jobs plus anything that finished within the recency window, newest
   * first. This is what the polled `GET /jobs` list serves (its consumers, the slicing toast
   * stack and the Jobs view's in-progress section, only ever look at running/just-finished
   * work), so the polled payload stays bounded while history grows; the full history is paged
   * by `GET /api/jobs/history` through {@link list}. The window exists for the toast stack,
   * which keeps a finished job's toast up for a beat after it settles: comfortably inside
   * five minutes.
   */
  listActive(workspaceId: string): SlicingJob[] {
    const cutoff = Date.now() - ACTIVE_LIST_RECENT_WINDOW_MS
    return this.list(workspaceId).filter(
      (job) => isActiveSlicingJob(job) || Date.parse(job.updatedAt) >= cutoff
    )
  }

  /** Prepared proofs still needed by queued/running jobs or by a failed job the user can retry. */
  preparedSourceIdsForRetention(): string[] {
    return Array.from(this.jobs.values())
      .filter((job) => job.request.preparedSource && (
        job.status === 'queued'
        || job.status === 'preparing'
        || job.status === 'slicing'
        || job.status === 'saving'
        || job.status === 'failed'
      ))
      .map((job) => job.request.preparedSource!.id)
  }

  get(workspaceId: string, jobId: string): SlicingJob {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    this.recomputeQueuePositions()
    return toDto(job)
  }

  /**
   * Repoint a job's saved output. Used when saving the output over an existing
   * library file folds it into that row: follow-up actions (e.g. "Print"
   * after saving) must dispatch the surviving file id.
   */
  setOutputFile(workspaceId: string, jobId: string, output: { id: string; name: string }): void {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    job.outputFileId = output.id
    job.outputFileName = output.name
    this.schedulePersist()
  }

  enqueue(input: {
    workspaceId: string
    workspace: RequestWorkspaceSummary
    executionTier?: Exclude<SlicingExecutionTier, 'anonymous'>
    sourceFileId: string
    sourceFileName: string
    sourcePath: string
    targetBridgeId: string | null
    executionPrinterModel?: string | null
    request: CreateSlicingJob
    profileFiles?: ResolvedSlicingPresetFile[]
  }): SlicingJob {
    if (!slicerClient.isConfigured()) {
      throw new HttpError(503, 'Slicer service is not configured')
    }
    const queuedCount = Array.from(this.jobs.values()).filter((job) => job.status === 'queued').length
    if (queuedCount >= env.SLICING_MAX_QUEUED_JOBS) {
      throw conflict('Too many slicing jobs are already queued. Try again after one starts or finishes.')
    }

    const now = new Date()
    const cacheLookupPending = Boolean(
      this.lookupResultCache
      && input.targetBridgeId
      && input.request.hiddenOutput === true
    )
    const job: SlicingJobState = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workspace: input.workspace,
      executionTier: input.executionTier ?? 'paid',
      sourceFileId: input.sourceFileId,
      sourceFileName: input.sourceFileName,
      sourcePath: input.sourcePath,
      targetBridgeId: input.targetBridgeId,
      executionPrinterModel: input.executionPrinterModel ?? null,
      outputFileId: null,
      outputFileName: input.request.outputFileName ?? null,
      thumbnailPath: null,
      request: input.request,
      profileFiles: input.profileFiles ?? [],
      status: 'queued',
      queuePosition: null,
      slicerName: null,
      metadata: undefined,
      output: [],
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      controller: null,
      activeSlicerJobId: null,
      lostReason: null,
      cacheKey: null,
      cacheHasFilamentTrackSwitch: null,
      cacheLookupPending
    }
    this.jobs.set(job.id, job)
    this.logJobEvent(job, 'info', `Queued slicing job for ${job.sourceFileName}`, {
      targetMode: job.request.target.mode,
      plate: job.request.plate,
      profileCount: job.profileFiles.length
    })
    if (cacheLookupPending) {
      void this.resolveCachedResult(job)
    } else {
      this.pumpQueue()
    }
    this.recomputeQueuePositions()
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
    return toDto(job)
  }

  cancel(workspaceId: string, jobId: string): SlicingJob {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') return toDto(job)
    job.cancelRequested = true
    job.controller?.abort()
    if (job.status === 'queued') {
      slicingExecutionScheduler.cancel(job.id)
      this.finish(job, 'cancelled', 'Cancelled before slicing started')
      this.logJobEvent(job, 'warn', 'Cancelled queued slicing job before start')
      this.pumpQueue()
    } else {
      this.touch(job, 'Cancelling...')
      this.logJobEvent(job, 'warn', 'Cancellation requested for active slicing job')
    }
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
    return toDto(job)
  }

  /**
   * Re-arm a FAILED job and queue it again, keeping its id.
   *
   * Same job, not a new one, mirroring `printDispatcher.retry`. The id is what the toast stack and
   * every slice dialog (`SliceThenPrintModal`, `SliceResultModal`, `CalibrationSlicePrintModal`,
   * `SliceToQueueFlow`) track a slice by, so minting a fresh one would leave whatever the user is
   * looking at watching a job that will never move again.
   *
   * Re-running is safe because nothing about a slice is consumed by attempting it: `request` and
   * `profileFiles` are the caller's original inputs, held verbatim and persisted, and `run()`
   * re-resolves `sourcePath` from the pinned content base on every attempt, so a swept temp copy
   * re-fetches rather than failing.
   *
   * Non-failed statuses are returned unchanged rather than rejected, so a double-click (or two tabs
   * racing the same toast) is a no-op instead of an error. The guards `enqueue` applies are applied
   * here too: a retry occupies a queue slot exactly like a new slice does.
   *
   * `ownerClientId` re-stamps the job onto the tab asking for the retry. It decides who sees the
   * toast (`SlicingToasts` filters on it) and whose departure cancels the work
   * (`cancelForOwner`), and both of those must follow the retry, not the tab that first failed.
   * Pass null only for a caller that is not a browser tab, which leaves the job unowned and so
   * visible to everyone, matching how a script-started slice behaves.
   */
  retry(workspaceId: string, jobId: string, ownerClientId: string | null): SlicingJob {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    if (job.status !== 'failed') return toDto(job)

    if (!slicerClient.isConfigured()) {
      throw new HttpError(503, 'Slicer service is not configured')
    }
    const queuedCount = Array.from(this.jobs.values()).filter((entry) => entry.status === 'queued').length
    if (queuedCount >= env.SLICING_MAX_QUEUED_JOBS) {
      throw conflict('Too many slicing jobs are already queued. Try again after one starts or finishes.')
    }

    job.status = 'queued'
    job.queuePosition = null
    job.error = null
    // Drop the failed attempt's engine log: it is the reason the retry exists, and keeping it would
    // leave the new run's output appended to a failure that did not happen this time.
    job.output = []
    job.metadata = undefined
    job.slicerName = null
    job.startedAt = null
    job.finishedAt = null
    job.cancelRequested = false
    job.controller = null
    job.activeSlicerJobId = null
    job.lostReason = null
    // `outputFileName` is set BEFORE the artifact is persisted, so a save that fails (a bridge
    // offline, a full disk) leaves the failed job holding a name the next attempt would inherit:
    // `run()` reads `result.outputFileName ?? job.outputFileName`, so a slicer that returns none
    // re-uses the previous attempt's already-deduplicated name and the save produces
    // "part (2) (2).gcode.3mf". `outputFileId` is cleared alongside it. That one is not reachable
    // today (both steps after the persist swallow their own errors by contract, so a job cannot
    // currently fail with an id set), and it is reset anyway so the retry's contract does not
    // depend on two distant best-effort catches staying that way: an id here would make the queued
    // job advertise the previous attempt's sliced file and point `ensureHistoryThumbnail` at it,
    // which is the same staleness the `thumbnailPath` reset above exists to fix. The library row is
    // untouched either way; only this job stops claiming it.
    job.outputFileId = null
    // Back to what `enqueue` seeded, NOT to null: the request may NAME the output, and `run()` reads
    // `result.outputFileName ?? job.outputFileName ?? <source-derived default>`, so nulling it made a
    // retry fall through to the default whenever the slicer answered without a name (an older
    // slicer, a header that would not decode) where the first attempt used the requested one. It is
    // also the toast's title (`job.outputFileName ?? job.sourceFileName`).
    job.outputFileName = job.request.outputFileName ?? null
    // The FAILED attempt already persisted a thumbnail, and with no output yet `ensureHistoryThumbnail`
    // could only derive it from the SOURCE file. That function early-returns on a path being set, so
    // leaving this would make a successful retry keep the pre-slice preview forever where an
    // identical first-try slice shows the sliced plate cover. Dropped best-effort, like every other
    // thumbnail operation: failing to unlink an image must never fail the retry.
    const staleThumbnailPath = job.thumbnailPath
    job.thumbnailPath = null
    if (staleThumbnailPath) {
      void deletePrintJobThumbnail(staleThumbnailPath).catch(() => undefined)
    }
    job.request = { ...job.request, ownerClientId: ownerClientId ?? undefined }
    job.updatedAt = new Date()
    // `createdAt` deliberately stands: it is when the user asked for this slice, and `pumpQueue`
    // orders on it, so keeping it lets a retry resume its original place rather than queue behind
    // work submitted while it was failing.
    this.logJobEvent(job, 'info', `Retrying slicing job for ${job.sourceFileName}`)
    this.pumpQueue()
    this.recomputeQueuePositions()
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
    return toDto(job)
  }

  /**
   * Cancel every still-running job started by a browser tab that has closed for good.
   *
   * Called by the `client-sessions.ts` departure signal, which is already grace-delayed, a reload
   * or a flaky socket never reaches here. Deliberately NOT workspace-scoped: the caller is a socket
   * lifecycle, not a request, and the owner id was minted by the tab that also created the job, so
   * it selects exactly that tab's own work and nothing else. Terminal jobs are left alone: the
   * output of a finished slice belongs to the user, not to the tab that happened to start it.
   */
  cancelForOwner(ownerClientId: string): void {
    for (const job of this.jobs.values()) {
      if (job.request.ownerClientId !== ownerClientId) continue
      if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') continue
      this.logJobEvent(job, 'warn', 'Cancelling slicing job: the tab that started it closed')
      this.cancel(job.workspaceId, job.id)
    }
  }

  async delete(workspaceId: string, jobId: string): Promise<SlicingJob> {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    if (job.status === 'queued' || job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving') {
      throw conflict('Cannot delete an active slicing job')
    }
    const dto = toDto(job)
    this.jobs.delete(jobId)
    if (job.thumbnailPath) {
      await deletePrintJobThumbnail(job.thumbnailPath)
    }
    this.recomputeQueuePositions()
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
    return dto
  }

  getThumbnailInfo(workspaceId: string, jobId: string): {
    thumbnailPath: string | null
    sourceFileId: string
    outputFileId: string | null
    plate: number
  } {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    return {
      thumbnailPath: job.thumbnailPath,
      sourceFileId: job.sourceFileId,
      outputFileId: job.outputFileId,
      plate: job.request.plate > 0 ? job.request.plate : 1
    }
  }

  setThumbnailPath(workspaceId: string, jobId: string, thumbnailPath: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.workspaceId !== workspaceId) throw notFound('Slicing job not found')
    if (job.thumbnailPath === thumbnailPath) return
    job.thumbnailPath = thumbnailPath
    this.schedulePersist()
  }

  /**
   * Does this slice's target printer have a set-up Filament Track Switch?
   *
   * Read from LIVE printer status rather than the request: the browser could only send what was
   * true when the dialog opened, and the value has to describe the machine at slice time for the
   * printer's own slice-vs-machine check to agree with it. An offline printer (no status) reads as
   * "no switch", which matches how an absent `has_filament_switcher` is interpreted everywhere.
   */
  private targetHasFilamentTrackSwitch(target: CreateSlicingJob['target']): boolean {
    if (target.mode !== 'realPrinter') return false
    const status = printerManager.getStatus(target.printerId)
    return status ? isFilamentTrackSwitchReady(status) : false
  }

  /**
   * Resolve a cache hit before this job occupies a scarce native-engine slot.
   *
   * Lookup and bridge-copy failures degrade to a normal queued slice. A hit owns a fresh hidden
   * output, so cancellation/discard can clean it without affecting the immutable cached artifact.
   */
  private async resolveCachedResult(job: SlicingJobState): Promise<void> {
    await withWorkspaceRequestContext(job.workspace, async () => {
      let materializedHit: SliceCacheHit | null = null
      try {
        const targetBridgeId = job.targetBridgeId
        const cache = this.lookupResultCache
        if (!targetBridgeId || !cache) return

        const capabilities = await this.resolveSlicerCapabilities()
        const targetId = job.request.slicerTargetId ?? capabilities.defaultTargetId
        const slicerTarget = targetId
          ? capabilities.targets.find((candidate) => candidate.id === targetId) ?? null
          : null
        if (!slicerTarget) return

        job.slicerName = slicerTarget.slicerName
        const hasFilamentTrackSwitch = this.targetHasFilamentTrackSwitch(job.request.target)
        job.cacheHasFilamentTrackSwitch = hasFilamentTrackSwitch
        const lookupInput: SliceCacheLookupInput = {
          workspaceId: job.workspaceId,
          sourceFileId: job.sourceFileId,
          sourceFileName: job.sourceFileName,
          sourcePath: job.sourcePath,
          targetBridgeId,
          executionPrinterModel: job.executionPrinterModel,
          hasFilamentTrackSwitch,
          request: job.request,
          profileFiles: job.profileFiles,
          slicerTarget
        }
        const lookup = await cache(lookupInput)
        job.cacheKey = lookup.cacheKey
        materializedHit = lookup.hit
        if (!materializedHit) return

        // A cancel may arrive while the bridge is copying the immutable artifact. Never attach the
        // completed copy to a terminal job; discard it below after leaving this branch.
        if (job.status !== 'queued' || job.cancelRequested) return

        job.cacheLookupPending = false
        job.startedAt = new Date()
        job.outputFileId = materializedHit.outputFileId
        job.outputFileName = materializedHit.outputFileName
        job.slicerName = materializedHit.slicerName ?? slicerTarget.slicerName
        job.metadata = materializedHit.metadata
        this.setStatus(job, 'saving', 'Using the unchanged slice')
        await this.ensureHistoryThumbnail(job)
        if (job.cancelRequested) {
          this.finish(job, 'cancelled', 'Slicing cancelled')
          return
        }
        this.logJobEvent(job, 'info', 'Reused cached slicing result', {
          outputFileId: materializedHit.outputFileId,
          cacheKey: job.cacheKey
        })
        this.finish(job, 'ready', 'Slicing complete')
      } catch (error) {
        this.logJobEvent(
          job,
          'warn',
          `Slice cache lookup failed; slicing normally: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        if (materializedHit && (job.status === 'cancelled' || job.status === 'failed')) {
          try {
            await discardHiddenSlicedOutput(materializedHit.outputFileId)
          } catch (error) {
            this.logJobEvent(
              job,
              'warn',
              `Could not discard unused cached output: ${error instanceof Error ? error.message : String(error)}`
            )
          }
        }
        job.cacheLookupPending = false
        if (job.status === 'queued' && !job.cancelRequested) {
          this.pumpQueue()
        }
        this.recomputeQueuePositions()
        this.schedulePersist()
        broadcastSlicingChanged(job.workspaceId)
      }
    })
  }

  private pumpQueue(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || job.cancelRequested || job.cacheLookupPending) continue
      slicingExecutionScheduler.enqueue({
        id: job.id,
        tier: job.executionTier,
        createdAt: job.createdAt,
        start: () => {
          job.status = 'preparing'
          void this.run(job)
        }
      })
    }
  }

  private async run(job: SlicingJobState): Promise<void> {
    await withWorkspaceRequestContext(job.workspace, async () => {
      const controller = new AbortController()
      const progressController = new AbortController()
      let observedOutputCount = 0
      job.controller = controller
      job.startedAt = new Date()
      this.logJobEvent(job, 'info', 'Starting slicing job execution')
      // The watchdog half: when the slicer stops acknowledging this job, abort the slice with the
      // reason rather than letting a half-open POST run to the 30-minute ceiling. `lostReason` is
      // what tells the catch below this was a loss, not the user pressing Cancel.
      const progressTracker = this.trackLiveOutput(job, progressController.signal, (reason) => {
        job.lostReason = reason
        controller.abort(new Error(reason))
      }).then((count) => {
        observedOutputCount = count
        return count
      })
      // `slicing` is NOT set here: everything runSlicerJob does before it hands the file over
      // (baking the editor's scene, authoring the machine, welding meshes) is preparation, and on
      // a big project it is the slow part. Announcing "slicing" over it reported the wrong phase
      // for the whole prep: runSlicerJob flips the status itself once the engine has the file.
      this.setStatus(
        job,
        'preparing',
        job.request.preparedSource ? 'Sending project to the slicer' : 'Applying slice settings to the project'
      )
      // Declared outside the try so the artifact temp dir is cleaned on EVERY exit path
      // (persist failure, cancel during saving, ...), not only on success.
      let result: Awaited<ReturnType<typeof this.runSlicerJob>> | null = null
      try {
        result = await this.runSlicerJob(job, controller.signal)
        progressController.abort()
        await progressTracker
        this.appendCliOutput(job, result.output.slice(observedOutputCount))
        job.metadata = result.metadata
        job.outputFileName = normalizeOutputFileName(result.outputFileName ?? job.outputFileName ?? buildDefaultOutputFileName(job.sourceFileName))
        this.setStatus(job, 'saving', slicedArtifactSavingMessage(job.request))
        // Bake the editor's rendered plate previews into the sliced output so its library
        // thumbnail reflects the edited layout: BambuStudio's CLI won't regenerate thumbnails
        // for a project with explicit (editor-set) positions. Best-effort: a failure here must
        // not fail an otherwise-successful slice.
        // Editor renders take precedence; otherwise a caller with no sceneEdit (e.g. calibration)
        // can supply plate covers directly on the request.
        const plateThumbnails = job.request.sceneEdit?.plateThumbnails ?? job.request.plateThumbnails
        if (plateThumbnails && plateThumbnails.length > 0) {
          await embedPlateThumbnails(
            result.artifactPath,
            plateThumbnails.map((thumb) => ({ plateIndex: thumb.plateIndex, png: Buffer.from(thumb.png, 'base64') }))
          ).catch((error: unknown) => {
            this.logJobEvent(job, 'warn', `Could not embed plate thumbnails: ${(error as Error).message}`)
          })
          // Drop the (large base64) thumbnails now they're consumed, so the persisted job state
          // doesn't carry them.
          job.request = job.request.sceneEdit
            ? { ...job.request, sceneEdit: { ...job.request.sceneEdit, plateThumbnails: undefined } }
            : { ...job.request, plateThumbnails: undefined }
        }
        // A cancel that landed during slicing/saving: don't persist the artifact the user
        // cancelled. (The finally block cleans the artifact temp dir.)
        if (job.cancelRequested || controller.signal.aborted) {
          this.finish(job, 'cancelled', 'Slicing cancelled')
          return
        }
        const info = await stat(result.artifactPath)
        const { file: saved } = await this.persistArtifact({
          workspaceId: job.workspaceId,
          sourcePath: result.artifactPath,
          fileName: job.outputFileName,
          sizeBytes: info.size,
          folderId: job.request.outputFolderId ?? null,
          bridgeId: job.targetBridgeId,
          hidden: shouldHideSlicedArtifact(job.request),
          auditAction: 'slice'
        })
        job.outputFileId = saved.id
        job.outputFileName = saved.name
        // Only now that the output is durable: a snapshot for a cancelled or unsaved slice
        // would never be swept (see print-file-snapshots.ts) and nothing would point at it.
        const sourceProjectFileId = await this.keepSlicedProject(job, result.preparedProjectPath, saved)
        await this.keepSlicingResultCache(job, saved, sourceProjectFileId)
        await this.ensureHistoryThumbnail(job)
        this.logJobEvent(job, 'info', `Saved sliced artifact as ${saved.name}`, {
          outputFileId: saved.id,
          sizeBytes: info.size
        })
        await rm(result.artifactPath, { force: true }).catch(() => undefined)
        await rm(pathDirname(result.artifactPath), { recursive: true, force: true }).catch(() => undefined)
        this.finish(job, 'ready', slicedArtifactReadyMessage(job.request))
      } catch (error) {
        await this.ensureHistoryThumbnail(job)
        // Checked BEFORE the cancel branch: the watchdog aborts the same controller the user's
        // Cancel does, and reporting a lost slice as "Slicing cancelled" would blame the user for
        // the slicer going away.
        if (job.lostReason && !job.cancelRequested) {
          this.finish(job, 'failed', job.lostReason)
        } else if (job.cancelRequested || controller.signal.aborted) {
          this.finish(job, 'cancelled', 'Slicing cancelled')
        } else {
          if (error instanceof SlicerServiceError) {
            this.appendCliOutput(job, error.output.slice(observedOutputCount))
          }
          this.finish(job, 'failed', (error as Error).message || 'Slicing failed')
        }
      } finally {
        // Always remove the slicer artifact temp dir (a ≤1 GiB .gcode.3mf); the success path
        // already removed it, but a failure/cancel after the slice completed would otherwise leak it.
        if (result?.artifactPath) {
          await rm(pathDirname(result.artifactPath), { recursive: true, force: true }).catch(() => undefined)
        }
        // Same for the staged project copy: preserved by now on the success path, and
        // deliberately discarded on every other, where no output points at it.
        if (result?.preparedProjectPath) {
          await rm(pathDirname(result.preparedProjectPath), { recursive: true, force: true }).catch(() => undefined)
        }
        progressController.abort()
        await progressTracker.catch(() => undefined)
        job.controller = null
        job.activeSlicerJobId = null
        slicingExecutionScheduler.complete(job.id)
        this.recomputeQueuePositions()
        this.schedulePersist()
        broadcastSlicingChanged(job.workspaceId)
        this.pumpQueue()
      }
    })
  }

  private async runSlicerJob(job: SlicingJobState, signal: AbortSignal) {
    const profileFiles = job.profileFiles
    const request = job.request
    // Re-resolve the source instead of blindly trusting the persisted path: a
    // job re-driven after a restart (or a source delete/replace) may hold a
    // _bridge-cache path that no longer exists. resolveSource re-fetches on
    // demand and fails with a clear message if the source is truly gone.
    let sourcePath = await this.resolveSource({
      sourceFileId: job.sourceFileId,
      sourcePath: job.sourcePath,
      workspaceId: job.workspaceId,
      contentBase: job.request.contentBase ?? null,
      preparedSource: job.request.preparedSource ?? null
    })
    const rewrittenSourcePaths: string[] = []
    let retryAttempt = 0

    try {
      // Slice-time object customization: when the caller deselected objects and/or set per-object
      // process overrides on a single plate, produce a customized copy of the source 3MF (mark
      // unselected objects' build items unprintable so the slicer drops them, inject per-object
      // metadata) and slice that instead. Tracked in rewrittenSourcePaths so the finally block
      // cleans it up. A failure here fails the job rather than silently ignoring the customization.
      // Interactive 3D editor arrangement: when the caller edited the plate layout, regenerate the
      // source 3MF's build items and plate/instance metadata so the moved/rotated/scaled/added/
      // removed models (across multiple plates) are sliced. The edit is authoritative over the
      // single-plate object selection below, so the two paths are mutually exclusive.
      const sceneEdit = job.request.sceneEdit
      if (sceneEdit) {
        const imports = resolveSceneEditImports(job.workspaceId, sceneEdit)
        const arrangedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-arrange-'))
        const arrangedPath = path.join(arrangedDir, path.basename(job.sourceFileName) || 'source.3mf')
        rewrittenSourcePaths.push(arrangedPath)
        const { replacedObjectIds, clonedObjectIds } = await buildEditedThreeMf(sourcePath, arrangedPath, sceneEdit, imports)
        sourcePath = arrangedPath

        // Per-object PROCESS overrides set in the editor are applied to the arranged 3MF here:
        // the single-plate object-customization path below is skipped whenever an edit is present
        // (it expresses object selection via the edit's printability instead). Overrides for an
        // object replaced via "Replace with…" are re-keyed onto the baked object_id its
        // replacement landed on, so the object's overrides follow the new mesh; an INDEPENDENT
        // COPY is re-keyed the same way, off its placeholder id, so slicing one never needs a save.
        const editorOverrides = job.request.objectProcessOverrides
        if (editorOverrides && Object.keys(editorOverrides).length > 0) {
          const effectiveOverrides = rekeyReplacedObjectOverrides(editorOverrides, [...replacedObjectIds, ...clonedObjectIds])
          const customizedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-objcustom-'))
          const customizedPath = path.join(customizedDir, path.basename(job.sourceFileName) || 'source.3mf')
          rewrittenSourcePaths.push(customizedPath)
          await createObjectCustomizedThreeMf(sourcePath, customizedPath, job.request.plate, {
            objectProcessOverrides: effectiveOverrides
          })
          sourcePath = customizedPath
        }
      }

      const selectedObjectIds = job.request.selectedObjectIds
      const objectProcessOverrides = job.request.objectProcessOverrides
      const hasObjectCustomization = (selectedObjectIds && selectedObjectIds.length > 0)
        || (objectProcessOverrides && Object.keys(objectProcessOverrides).length > 0)
      // Slice-time layer G-code edits (filament changes / pauses) from the prepare-print dialog.
      // `undefined` means untouched; a present-but-empty list is a deliberate clear, so the guard
      // checks presence, not length. sceneEdit slices carry these inside the edit instead.
      const hasGcodeEdits = job.request.filamentChanges !== undefined || job.request.pauses !== undefined
      if (!sceneEdit && ((job.request.plate > 0 && hasObjectCustomization) || hasGcodeEdits)) {
        const filteredDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-objcustom-'))
        const filteredPath = path.join(filteredDir, path.basename(job.sourceFileName) || 'source.3mf')
        rewrittenSourcePaths.push(filteredPath)
        const applyObjectCustomization = job.request.plate > 0 && hasObjectCustomization
        await createObjectCustomizedThreeMf(sourcePath, filteredPath, job.request.plate, {
          selectedObjectIds: applyObjectCustomization && selectedObjectIds && selectedObjectIds.length > 0 ? selectedObjectIds : undefined,
          objectProcessOverrides: applyObjectCustomization && objectProcessOverrides && Object.keys(objectProcessOverrides).length > 0 ? objectProcessOverrides : undefined,
          customGcode: hasGcodeEdits ? { filamentChanges: job.request.filamentChanges, pauses: job.request.pauses } : undefined
        })
        sourcePath = filteredPath
      }

      // We author the 3MF; the CLI only slices it. Write the SELECTED machine's complete settings
      // into whatever project we are about to hand over, so it leaves here fully self-defined,
      // including an H2-family printer's extruder-indexed dual-nozzle topology. A project can name
      // `printer_model: H2D` while carrying none of that topology (a new editor project, and any
      // 3MF we build from scratch such as the calibration plates), and the CLI then refuses it
      // ("missing its dual-nozzle machine data") or slices with no print volume: "no object fully
      // inside the print volume", exit 206. Deliberately applied to every LEGACY slice path, not
      // just editor (sceneEdit) slices: calibration and plain library slices bake no scene but hand
      // over the same under-defined projects. A browser-prepared source already carries this exact
      // authoring and must not be rewritten here. Never rely on the slicer to retarget or on built-in
      // profile fallbacks surviving; best-effort, so an unresolvable machine degrades to the old
      // behaviour.
      if (!job.request.preparedSource) {
        const machineProfile = job.profileFiles.find((profile) => profile.kind === 'machine')
        if (machineProfile) {
          const authoredPath = await authorProjectMachineFromProfile({
            arrangedPath: sourcePath,
            fileName: path.basename(job.sourceFileName) || 'source.3mf',
            slicerTargetId: job.request.slicerTargetId,
            machineFile: machineProfile
          }).catch((error: unknown) => {
            this.logJobEvent(job, 'warn', `Could not author the machine into the project: ${error instanceof Error ? error.message : String(error)}`)
            return null
          })
          if (authoredPath) {
            rewrittenSourcePaths.push(authoredPath)
            sourcePath = authoredPath
          } else {
            this.logJobEvent(job, 'warn', `Slicing without an authored machine: could not resolve ${machineProfile.name}`)
          }
        }
      }

      // On a legacy source, now the machine is in, author the REST of this slice's settings: the
      // chosen process preset, each slot's filament preset, the dialog's per-slice and
      // per-material overrides, and the plate type. All of those otherwise reach the CLI only as
      // command-line profile files, leaving the project ignorant of what it was sliced with, which
      // is what made a preserved project reopen with its old presets, and what let a project's own
      // settings outrank the chosen preset on the compatibility-fallback retry. Must run AFTER the
      // machine step: the process and filament writes index the topology maps it rebuilds. A
      // browser-prepared source skips those editor-owned writes but still receives live runtime
      // facts that the tab cannot author safely. Best-effort, a slice that worked before must still
      // work.
      {
        const hasFilamentTrackSwitch = this.targetHasFilamentTrackSwitch(job.request.target)
        if (
          job.cacheKey
          && job.cacheHasFilamentTrackSwitch !== hasFilamentTrackSwitch
        ) {
          // The pre-queue lookup hashed the live state it observed. If that fact changed while this
          // job waited, the project authored below cannot be stored under the earlier identity.
          // Skip this one cache fill; the completed slice remains fully usable.
          job.cacheKey = null
          job.cacheHasFilamentTrackSwitch = hasFilamentTrackSwitch
          this.logJobEvent(job, 'info', 'Live printer configuration changed while queued; skipping slice cache write')
        }
        const authoredPath = await this.authorSliceSettings({
          workspaceId: job.workspaceId,
          slicerTargetId: job.request.slicerTargetId,
          target: job.request.target,
          projectPath: sourcePath,
          fileName: path.basename(job.sourceFileName) || 'source.3mf',
          hasFilamentTrackSwitch,
          // The browser-prepared-v1 contract makes every editor-owned setting in the snapshot
          // authoritative. Only the live printer fact above may still be authored here.
          runtimeOnly: job.request.preparedSource?.contractVersion === 1
        }).catch((error: unknown) => {
          this.logJobEvent(job, 'warn', `Could not author the slice settings into the project: ${(error as Error).message}`)
          return null
        })
        if (authoredPath) {
          rewrittenSourcePaths.push(authoredPath)
          sourcePath = authoredPath
        }
      }

      // Heal index-level triangle-soup meshes (older editor imports) on legacy inputs before slicing:
      // BambuStudio chains layer contours by vertex index, so unwelded meshes fall into
      // its 2mm gap-closing heuristic and small features (inlaid text) slice mangled.
      // No-op (no copy) for projects whose meshes are already welded, and best-effort
      // overall, a heal failure must never fail a slice that would previously have run. Prepared
      // browser inputs already satisfy this invariant and must pass through unchanged.
      if (!job.request.preparedSource) {
        const weldedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-weld-'))
        const weldedPath = path.join(weldedDir, path.basename(job.sourceFileName) || 'source.3mf')
        let healed = false
        try {
          healed = await healUnweldedThreeMfMeshes(sourcePath, weldedPath)
        } catch (error) {
          this.logJobEvent(job, 'warn', `Mesh weld pre-pass skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (healed) {
          rewrittenSourcePaths.push(weldedPath)
          sourcePath = weldedPath
        } else {
          await rm(weldedDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }

      // Preparation is done and the project is about to reach the engine: this is the first
      // moment "slicing" is true (see the deliberately absent transition in run()).
      this.setStatus(job, 'slicing', 'Starting the slice')

      let crashRetryUsed = false
      while (true) {
        const slicerJobId = buildSlicerAttemptJobId(job.id, retryAttempt)
        job.activeSlicerJobId = slicerJobId
        try {
          const result = await slicerClient.run({
            jobId: slicerJobId,
            sourceFileName: job.sourceFileName,
            sourcePath,
            request,
            profileFiles,
            executionHints: { printerModel: job.executionPrinterModel },
            signal
          })
          // Staged from INSIDE the try: these paths point into a temp dir the finally below
          // deletes, and this is the last moment they still exist. This IS the project the engine
          // consumed, with no caveat: the only path that ever handed the archive different bytes
          // was the profile-compatibility retry, which is gone (see the catch below).
          return {
            ...result,
            preparedProjectPath: await this.stagePreparedProject(job, sourcePath)
          }
        } catch (error) {
          // A signal-death exit (segfault et al.) gets ONE retry with unchanged inputs: under
          // qemu emulation the engine crashes intermittently on runs that slice clean when
          // re-run, and a single flake otherwise fails the whole job.
          if (!crashRetryUsed && isTransientSlicerCrashExit(error)) {
            crashRetryUsed = true
            retryAttempt += 1
            const retryMessage = 'The slicer crashed mid-run; retrying'
            this.touch(job, retryMessage)
            this.logJobEvent(job, 'warn', retryMessage)
            broadcastSlicingChanged(job.workspaceId)
            continue
          }
          // A failed slice FAILS. There used to be a second retry here that dropped the built-in
          // preset files the engine rejected and blanked the project's matching preset identities,
          // then reported success. It could not be correct: the print it produced was not the one
          // the user configured, and nothing said so.
          //
          // It is not needed either, which is the part worth keeping. BambuStudio's CLI slices a
          // project with no preset flags from the embedded `project_settings.config` alone
          // (`BambuStudio.cpp:3516` gates filament re-application on `--load-filaments`/`--uptodate`,
          // and it never builds a `PresetBundle`), and our slice authors the chosen presets into
          // that config before the engine sees it (`slice-settings-authoring.ts`). So the preset
          // files carry no information the project lacks, and dropping them cannot rescue a slice
          // that failed for a real reason.
          throw error
        }
      }
    } finally {
      for (const rewrittenSourcePath of rewrittenSourcePaths) {
        await rm(rewrittenSourcePath, { force: true }).catch(() => undefined)
      }
      for (const rewrittenSourcePath of rewrittenSourcePaths) {
        await rm(pathDirname(rewrittenSourcePath), { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  /**
   * Poll the slicer for live CLI output AND watch for the slice going missing.
   *
   * The second job is why the poll outcome is classified rather than ignored: this loop is the only
   * channel that notices a slicer restart promptly, because the slice's own POST can sit half-open
   * until the 30-minute request ceiling. `onLost` aborts the slice with a real reason (see
   * `slicer-contact.ts`); this loop keeps running afterwards so the abort's own teardown is still
   * reported.
   */
  private async trackLiveOutput(
    job: SlicingJobState,
    signal: AbortSignal,
    onLost?: (reason: string) => void
  ): Promise<number> {
    let observedOutputCount = 0
    let lastProgressUpdateAt = Date.now()
    let observedProgressJobId = job.activeSlicerJobId ?? job.id
    let contact = INITIAL_SLICER_CONTACT
    let gaveUp = false

    while (!signal.aborted) {
      try {
        const progressJobId = job.activeSlicerJobId ?? job.id
        if (progressJobId !== observedProgressJobId) {
          observedProgressJobId = progressJobId
          observedOutputCount = 0
          // A retry moved the slice to a fresh job id; the previous id's silence says nothing
          // about this one.
          contact = INITIAL_SLICER_CONTACT
        }
        const poll = await slicerClient.progress(progressJobId)
        contact = nextSlicerContact(contact, poll, Date.now())
        if (poll.kind === 'output' && poll.lines.length > observedOutputCount) {
          this.appendCliOutput(job, poll.lines.slice(observedOutputCount))
          observedOutputCount = poll.lines.length
          job.updatedAt = new Date()
          lastProgressUpdateAt = Date.now()
          broadcastSlicingChanged(job.workspaceId)
        }
      } catch (error) {
        if (!signal.aborted) {
          console.warn(`[slicing:${job.id}] failed to fetch live slicer output`, (error as Error).message)
        }
      }

      if (!signal.aborted && Date.now() - lastProgressUpdateAt >= this.progressHeartbeatIntervalMs) {
        this.appendProgressHeartbeat(job, contact)
        lastProgressUpdateAt = Date.now()
      }

      // Give up only once: the abort below unwinds the slice, and re-firing would overwrite the
      // recorded reason with a later, less specific one.
      if (!gaveUp && !signal.aborted && onLost) {
        const lostMessage = slicerContactGiveUpMessage(contact, Date.now(), {
          unknownMs: this.lostUnknownGraceMs,
          unreachableMs: this.lostUnreachableGraceMs
        })
        if (lostMessage) {
          gaveUp = true
          this.logJobEvent(job, 'warn', lostMessage)
          this.appendProgressHeartbeat(job, contact)
          onLost(lostMessage)
        }
      }

      if (signal.aborted) break
      await delay(this.progressPollIntervalMs, signal)
    }

    return observedOutputCount
  }

  private appendProgressHeartbeat(job: SlicingJobState, contact: SlicerContactState = INITIAL_SLICER_CONTACT): void {
    const message = slicerContactHeartbeat(contact, Date.now(), formatElapsedDuration(job.startedAt ?? job.createdAt))
    job.updatedAt = new Date()
    job.output.push({ stream: 'system', text: message, createdAt: job.updatedAt.toISOString() })
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
  }

  private setStatus(job: SlicingJobState, status: SlicingJobStatus, message: string): void {
    job.status = status
    this.touch(job, message)
    this.logJobEvent(job, 'info', `${status}: ${message}`)
    this.recomputeQueuePositions()
    this.schedulePersist()
    broadcastSlicingChanged(job.workspaceId)
  }

  private finish(job: SlicingJobState, status: 'ready' | 'failed' | 'cancelled', message: string): void {
    job.status = status
    job.error = status === 'failed' ? message : null
    job.finishedAt = new Date()
    recordSliceJob({
      outcome: status === 'ready' ? 'success' : status,
      durationMs: job.finishedAt.getTime() - (job.startedAt ?? job.createdAt).getTime()
    })
    this.touch(job, message)
    this.logJobEvent(job, status === 'failed' ? 'error' : 'info', `${status}: ${message}`)
    this.recomputeQueuePositions()
    this.schedulePersist()
  }

  private async ensureHistoryThumbnail(job: SlicingJobState): Promise<void> {
    if (job.thumbnailPath) return
    try {
      const thumbnailPath = await this.persistThumbnail({
        jobId: job.id,
        preferredFileIds: [job.outputFileId, job.sourceFileId],
        plate: job.request.plate > 0 ? job.request.plate : 1
      })
      if (!thumbnailPath) return
      job.thumbnailPath = thumbnailPath
      this.schedulePersist()
    } catch {
      // Thumbnail persistence is best-effort only.
    }
  }

  /**
   * Copy the project the engine was handed into a temp dir that outlives `runSlicerJob`'s
   * cleanup, so `run()` can preserve it once the sliced output is safely persisted.
   *
   * Staged rather than preserved directly because the two have different lifetimes: a slice
   * that is cancelled or fails during saving must leave no snapshot behind (snapshots are
   * never swept), and that is only known after the artifact is stored. Best-effort, a
   * staging failure costs the re-slice affordance, never the slice.
   */
  private async stagePreparedProject(job: SlicingJobState, preparedPath: string): Promise<string | null> {
    try {
      const stagedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-project-'))
      const stagedPath = path.join(stagedDir, path.basename(job.sourceFileName) || 'source.3mf')
      await copyFile(preparedPath, stagedPath)
      return stagedPath
    } catch (error) {
      this.logJobEvent(job, 'warn', `Could not keep the sliced project: ${(error as Error).message}`)
      return null
    }
  }

  /**
   * Keep the staged project (see `sliced-project-preservation.ts`) so this print can be
   * sliced again later. Best-effort: every failure here degrades to a print that simply
   * cannot be re-sliced, never to a failed slice.
   */
  private async keepSlicedProject(
    job: SlicingJobState,
    preparedProjectPath: string | null,
    saved: { id: string; ownerBridgeId: string | null }
  ): Promise<string | null> {
    if (!preparedProjectPath) return null
    try {
      const projectFileId = await this.preserveProject({
        workspaceId: job.workspaceId,
        fileName: job.sourceFileName,
        preparedProjectPath,
        output: saved,
        settings: toPreservedSliceSettings(job.request)
      })
      if (projectFileId) {
        this.logJobEvent(job, 'info', 'Kept the sliced project for re-slicing', { projectFileId })
      }
      return projectFileId
    } catch (error) {
      this.logJobEvent(job, 'warn', `Could not keep the sliced project: ${(error as Error).message}`)
      return null
    }
  }

  /** Cache a completed hidden output without making cache persistence part of slice success. */
  private async keepSlicingResultCache(
    job: SlicingJobState,
    saved: { id: string; name: string; ownerBridgeId: string | null },
    sourceProjectFileId: string | null
  ): Promise<void> {
    if (!job.cacheKey || !saved.ownerBridgeId || job.request.hiddenOutput !== true) return
    try {
      await this.storeResultCache({
        workspaceId: job.workspaceId,
        sourceFileId: job.sourceFileId,
        cacheKey: job.cacheKey,
        outputFileId: saved.id,
        outputFileName: saved.name,
        sourceProjectFileId,
        slicerName: job.slicerName,
        metadata: job.metadata,
        settings: toPreservedSliceSettings(job.request)
      })
      this.logJobEvent(job, 'info', 'Cached slicing result for unchanged re-slices', {
        cacheKey: job.cacheKey
      })
    } catch (error) {
      this.logJobEvent(
        job,
        'warn',
        `Could not cache the slicing result: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private touch(job: SlicingJobState, message: string): void {
    job.updatedAt = new Date()
    job.output.push({ stream: 'system', text: message, createdAt: job.updatedAt.toISOString() })
    this.schedulePersist()
  }

  private recomputeQueuePositions(): void {
    for (const job of this.jobs.values()) job.queuePosition = null
    for (const job of this.jobs.values()) {
      if (job.status === 'queued') job.queuePosition = slicingExecutionScheduler.position(job.id)
    }
  }

  private appendCliOutput(job: SlicingJobState, lines: SlicingOutputLine[]): void {
    if (lines.length === 0) return
    for (const line of lines) {
      job.output.push(line)
      this.logCliOutputLine(job, line)
    }
    this.schedulePersist()
  }

  private logCliOutputLine(job: SlicingJobState, line: SlicingOutputLine): void {
    const message = `[slicing:${job.id}] ${line.stream}: ${line.text}`
    if (line.stream === 'stderr') {
      console.warn(message)
      return
    }
    console.debug(message)
  }

  private logJobEvent(job: SlicingJobState, level: 'info' | 'warn' | 'error', message: string, metadata?: Record<string, unknown>): void {
    const suffix = metadata ? ` ${JSON.stringify(metadata)}` : ''
    const line = `[slicing:${job.id}] ${message}${suffix}`
    if (level === 'warn') {
      console.warn(line)
      return
    }
    if (level === 'error') {
      console.error(line)
      return
    }
    console.info(line)
  }

  private hydrateFromDisk(): void {
    if (!this.persistencePath) return

    let parsed: PersistedSlicingJobsState | null = null
    try {
      const raw = readFileSync(this.persistencePath, 'utf8')
      parsed = JSON.parse(raw) as PersistedSlicingJobsState
    } catch {
      return
    }

    const jobs = Array.isArray(parsed?.jobs) ? parsed.jobs : []
    for (const persistedJob of jobs) {
      const hydrated = hydratePersistedJob(persistedJob)
      if (!hydrated) continue
      this.jobs.set(hydrated.id, hydrated)
    }
  }

  private schedulePersist(): void {
    if (!this.persistencePath) return
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persistToDisk()
    }, 150)
  }

  private async persistToDisk(): Promise<void> {
    if (!this.persistencePath) return

    const payload: PersistedSlicingJobsState = {
      jobs: Array.from(this.jobs.values()).map(serializeSlicingJobState)
    }

    const outputPath = this.persistencePath
    const tempPath = `${outputPath}.tmp`
    const body = `${JSON.stringify(payload, null, 2)}\n`

    this.persistPromise = this.persistPromise.then(async () => {
      await mkdir(path.dirname(outputPath), { recursive: true })
      await writeFile(tempPath, body, 'utf8')
      await rename(tempPath, outputPath)
    }).catch((error: unknown) => {
      console.warn('[slicing] failed to persist slicing jobs state', (error as Error).message)
      // Don't leave a partial .tmp behind on a write/rename failure.
      void rm(tempPath, { force: true }).catch(() => undefined)
    })

    await this.persistPromise
  }
}

function shouldHideSlicedArtifact(request: CreateSlicingJob): boolean {
  return request.hiddenOutput === true
}

/**
 * Narrow a slice request down to what re-slicing the PRESERVED project needs.
 *
 * Everything the request expressed about the project: the arranged scene, object selection,
 * per-object overrides, layer G-code edits, and (authored in by `slice-settings-authoring.ts`)
 * the process and filament presets with their overrides: is already baked into the project we
 * kept, so carrying it here would re-apply it to a project that already has it. What survives is
 * only what stays outside the file: the engine target, the plate scope, and the newer-project
 * acknowledgement. The preset target rides along because the dialog seeds its pickers from it,
 * not because re-slicing needs it.
 */
function toPreservedSliceSettings(request: CreateSlicingJob): PreservedSliceSettings {
  return {
    ...(request.slicerTargetId ? { slicerTargetId: request.slicerTargetId } : {}),
    target: request.target,
    plate: request.plate,
    ...(request.allowNewerProjectFile ? { allowNewerProjectFile: true } : {})
  }
}

// These strings are the job's user-facing status line, not a log: the web renders the newest
// `system` output line verbatim (`formatSlicingProgress`). Keep them plain, no "artifact",
// no "slicer service", nothing about how the pipeline is wired.
function slicedArtifactSavingMessage(request: CreateSlicingJob): string {
  return shouldHideSlicedArtifact(request)
    ? 'Finishing the sliced file'
    : 'Saving the sliced file to the library'
}

function slicedArtifactReadyMessage(request: CreateSlicingJob): string {
  return shouldHideSlicedArtifact(request)
    ? 'Slicing complete'
    : 'Sliced file saved to the library'
}

function serializeSlicingJobState(job: SlicingJobState): PersistedSlicingJobState {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    workspace: job.workspace,
    executionTier: job.executionTier,
    sourceFileId: job.sourceFileId,
    sourceFileName: job.sourceFileName,
    sourcePath: job.sourcePath,
    targetBridgeId: job.targetBridgeId,
    executionPrinterModel: job.executionPrinterModel,
    outputFileId: job.outputFileId,
    outputFileName: job.outputFileName,
    thumbnailPath: job.thumbnailPath,
    request: job.request,
    profileFiles: job.profileFiles,
    status: job.status,
    slicerName: job.slicerName,
    metadata: job.metadata,
    output: job.output,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    cancelRequested: job.cancelRequested,
    cacheKey: job.cacheKey,
    cacheHasFilamentTrackSwitch: job.cacheHasFilamentTrackSwitch
  }
}

function hydratePersistedJob(persisted: PersistedSlicingJobState): SlicingJobState | null {
  if (!persisted || typeof persisted !== 'object') return null
  if (typeof persisted.id !== 'string' || typeof persisted.workspaceId !== 'string' || typeof persisted.sourceFileId !== 'string') return null

  const createdAt = parseTimestamp(persisted.createdAt)
  const updatedAt = parseTimestamp(persisted.updatedAt) ?? createdAt
  if (!createdAt || !updatedAt) return null

  const startedAt = parseTimestamp(persisted.startedAt)
  const finishedAt = parseTimestamp(persisted.finishedAt)
  const output = Array.isArray(persisted.output)
    ? persisted.output.filter((entry) => typeof entry?.stream === 'string' && typeof entry?.text === 'string' && typeof entry?.createdAt === 'string')
    : []

  let status = persisted.status
  let error = persisted.error
  let completedAt = finishedAt
  if (status === 'preparing' || status === 'slicing' || status === 'saving') {
    status = 'failed'
    error = INTERRUPTED_SLICING_MESSAGE
    completedAt = new Date()
    output.push({
      stream: 'system',
      text: INTERRUPTED_SLICING_MESSAGE,
      createdAt: completedAt.toISOString()
    })
  }

  return {
    id: persisted.id,
    workspaceId: persisted.workspaceId,
    workspace: persisted.workspace,
    executionTier: persisted.executionTier ?? 'paid',
    sourceFileId: persisted.sourceFileId,
    sourceFileName: persisted.sourceFileName,
    sourcePath: persisted.sourcePath,
    targetBridgeId: persisted.targetBridgeId,
    executionPrinterModel: typeof persisted.executionPrinterModel === 'string' ? persisted.executionPrinterModel : null,
    outputFileId: persisted.outputFileId,
    outputFileName: persisted.outputFileName,
    thumbnailPath: persisted.thumbnailPath,
    request: persisted.request,
    profileFiles: Array.isArray(persisted.profileFiles) ? persisted.profileFiles : [],
    status,
    queuePosition: null,
    slicerName: persisted.slicerName,
    metadata: persisted.metadata,
    output,
    error,
    createdAt,
    updatedAt: completedAt ?? updatedAt,
    startedAt,
    finishedAt: completedAt,
    cancelRequested: status === 'queued' ? Boolean(persisted.cancelRequested) : false,
    controller: null,
    activeSlicerJobId: null,
    lostReason: null,
    cacheKey: typeof persisted.cacheKey === 'string' ? persisted.cacheKey : null,
    cacheHasFilamentTrackSwitch: typeof persisted.cacheHasFilamentTrackSwitch === 'boolean'
      ? persisted.cacheHasFilamentTrackSwitch
      : null,
    // A process restart loses only the in-flight probe. Requeue the job normally; a later
    // successful run can still fill the cache from a key persisted before the restart.
    cacheLookupPending: false
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp)
}

function toDto(job: SlicingJobState): SlicingJob {
  return {
    id: job.id,
    sourceFileId: job.sourceFileId,
    sourceFileName: job.sourceFileName,
    slicerTargetId: job.request.slicerTargetId ?? null,
    outputFileId: job.outputFileId,
    outputFileName: job.outputFileName,
    target: job.request.target,
    plate: job.request.plate,
    ownerClientId: job.request.ownerClientId ?? null,
    status: job.status,
    queuePosition: job.queuePosition,
    slicerName: job.slicerName,
    metadata: job.metadata,
    output: job.output,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    cancelRequested: job.cancelRequested
  }
}

/** Still running, so its stdout progress frames are live. Mirrors the web's `isActiveSlicingJob`. */
function isActiveSlicingJobState(job: SlicingJobState): boolean {
  return job.status === 'queued' || job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving'
}

/** A finished job as the LIST returns it: status lines only, no engine log. See `list()`. */
/**
 * A terminal job as the LIST carries it: its last system line and nothing else.
 *
 * The list is every job this workspace has ever sliced, and `output` was its single largest field
 * (208 KB of 471 KB, measured over 194 jobs). A finished job's own progress frames are dead weight
 * there: the web renders a terminal job from `getLatestSystemOutputLine`, its outcome, never from
 * the frames (rendering those is what left a ready slice reading "Exporting 3mf (97%)"). The full
 * record, CLI output included, is still one `GET /jobs/:id` away.
 */
function toFinishedListDto(job: SlicingJobState): SlicingJob {
  const systemLines = job.output.filter((line) => line.stream === 'system')
  const lastMeaningful = [...systemLines].reverse().find((line) => line.text.trim() !== '')
  return { ...toDto(job), output: lastMeaningful ? [lastMeaningful] : [] }
}

function buildDefaultOutputFileName(sourceFileName: string): string {
  return sourceFileName.replace(/\.3mf$/i, '.gcode.3mf')
}

function normalizeOutputFileName(fileName: string): string {
  // Spaces, brackets, and most ASCII punctuation are valid in library/SD file names
  // (BambuStudio itself exports names like "Mount (landscape).gcode.3mf") and are
  // passed to the slicer CLI as a single argv token (no shell word-splitting). Only
  // strip what genuinely breaks downstream: path separators, FAT/firmware-reserved
  // punctuation, and control/non-ASCII characters: matching sanitizeRemoteName.
  const safe = fileName.replace(/[\\/<>:"|?*]/g, '_').replace(/[^\x20-\x7e]+/g, '_')
  return isDirectPrintableFileName(safe) ? safe : `${safe.replace(/\.3mf$/i, '')}.gcode.3mf`
}

function pathDirname(filePath: string): string {
  return filePath.slice(0, Math.max(0, filePath.lastIndexOf('/'))) || '.'
}

function buildSlicerAttemptJobId(jobId: string, retryAttempt: number): string {
  if (retryAttempt <= 0) return jobId
  return `${jobId}-retry-${retryAttempt}`
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, ms)

    const handleAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

function formatElapsedDuration(startedAt: Date): string {
  const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt.getTime()) / 1000))
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  if (minutes <= 0) return `${elapsedSeconds}s`
  if (seconds === 0) return `${minutes}m`
  return `${minutes}m ${seconds}s`
}

/**
 * A slicer CLI death by signal, exit 128+N (134 SIGABRT … 139 SIGSEGV), that is worth ONE retry
 * because it is likely transient. BambuStudio under qemu emulation (arm64 dev/self-host machines)
 * segfaults intermittently during project load/teardown on runs that slice clean when retried, so
 * one bounded retry absorbs the flake.
 *
 * A crash that happened *after the per-plate slice started* is NOT transient, it re-crashes
 * identically every time, and the slicer already reclassifies those into a "The slicing engine
 * crashed …" message (`formatSliceEngineCrashError`) that deliberately does NOT contain the
 * "exited with code 13x" text this predicate matches, so a deterministic engine crash falls through
 * to the failure path (with actionable guidance) instead of burning a futile second full slice.
 */
export function isTransientSlicerCrashExit(error: unknown): boolean {
  if (!(error instanceof SlicerServiceError)) return false
  return /Slicer CLI exited with code 13[4-9]\b/i.test(error.message)
}

export const slicingJobs = new SlicingJobs()

// Only the process-wide instance follows tab lifecycles; a SlicingJobs built by a test owns no
// sockets and must not react to another instance's tabs.
clientSessions.onGone((clientId) => slicingJobs.cancelForOwner(clientId))
