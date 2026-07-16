/**
 * In-memory orchestration for server-side slicing jobs.
 *
 * The API queues and scopes work while a separate slicer runtime owns
 * BambuStudio CLI execution. Completed artifacts are persisted back into the
 * library — {@link persistLibraryFileFromLocalPath} for the sliced file and
 * {@link persistHistoryThumbnailFromLibrary} for its history thumbnail.
 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CreateSlicingJob, SlicingJob, SlicingJobStatus, SlicingOutputLine, SlicingMetadata } from '@printstream/shared'
import { isDirectPrintableFileName } from '@printstream/shared'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import yazl from 'yazl'
import { env } from './env.js'
import { conflict, HttpError, notFound } from './http-error.js'
import { persistHistoryThumbnailFromLibrary } from './job-history-thumbnail-source.js'
import { persistLibraryFileFromLocalPath } from './library-files.js'
import { deletePrintJobThumbnail } from './print-job-thumbnails.js'
import { SlicerServiceError, slicerClient } from './slicer-client.js'
import { buildEditedThreeMf, createObjectCustomizedThreeMf, embedPlateThumbnails, rekeyReplacedObjectOverrides } from './three-mf.js'
import { healUnweldedThreeMfMeshes } from './three-mf-mesh-weld.js'
import { repairThreeMfMeshesToCopy, type MeshRepairStats } from './three-mf-mesh-repair.js'
import { resolveSceneEditImports } from './import-store.js'
import type { ResolvedSlicingProfileFile } from './slicing-profiles.js'
import { withTenantRequestContext, type RequestTenantSummary } from './tenant-context.js'
import { broadcastSlicingChanged } from './ws-resource-events.js'
import { recordSliceJob } from './metrics.js'
import { prisma } from './prisma.js'
import { resolveLibraryFileToLocalPath } from './bridge-library-files.js'

const DEFAULT_SLICING_PROGRESS_POLL_INTERVAL_MS = 750
const DEFAULT_SLICING_PROGRESS_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_SLICING_STATE_FILE = path.resolve(path.dirname(env.LIBRARY_DIR), 'slicing-jobs-state.json')
const INTERRUPTED_SLICING_MESSAGE = 'Slicing job was interrupted by an API restart. Requeue to try again.'

interface SlicingJobState {
  id: string
  tenantId: string
  tenant: RequestTenantSummary
  sourceFileId: string
  sourceFileName: string
  sourcePath: string
  targetBridgeId: string | null
  outputFileId: string | null
  outputFileName: string | null
  thumbnailPath: string | null
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingProfileFile[]
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
}

interface PersistedSlicingJobsState {
  jobs: PersistedSlicingJobState[]
}

interface PersistedSlicingJobState {
  id: string
  tenantId: string
  tenant: RequestTenantSummary
  sourceFileId: string
  sourceFileName: string
  sourcePath: string
  targetBridgeId: string | null
  outputFileId: string | null
  outputFileName: string | null
  thumbnailPath: string | null
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingProfileFile[]
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
}

export type PersistSlicedArtifact = typeof persistLibraryFileFromLocalPath
export type PersistSlicingHistoryThumbnail = typeof persistHistoryThumbnailFromLibrary
export type ResolveSlicingSource = (input: { sourceFileId: string; sourcePath: string }) => Promise<string>

/**
 * Resolve the local path to slice from. Prefers the persisted local/_bridge-cache
 * copy while it still exists (the common case — no behavior change); otherwise
 * re-resolves and re-fetches from the current library file, so a job that
 * outlived an API restart (fresh volume) or a source delete/replace doesn't fail
 * with an opaque ENOENT. Throws a clear, requeue-able message when the source can
 * no longer be resolved. Runs inside the job's tenant context (run() wraps it),
 * so the tenant-scoped client applies.
 */
export async function resolveSlicingSourcePath(input: { sourceFileId: string; sourcePath: string }): Promise<string> {
  try {
    await stat(input.sourcePath)
    return input.sourcePath
  } catch {
    // The cached copy is gone; re-resolve from the library file below.
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
  private readonly persistencePath: string | null
  private readonly persistArtifact: PersistSlicedArtifact
  private readonly persistThumbnail: PersistSlicingHistoryThumbnail
  private readonly resolveSource: ResolveSlicingSource
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private persistPromise: Promise<void> = Promise.resolve()

  constructor(options?: {
    progressPollIntervalMs?: number
    progressHeartbeatIntervalMs?: number
    persistState?: boolean
    stateFilePath?: string
    persistArtifact?: PersistSlicedArtifact
    persistThumbnail?: PersistSlicingHistoryThumbnail
    resolveSource?: ResolveSlicingSource
  }) {
    this.progressPollIntervalMs = options?.progressPollIntervalMs ?? DEFAULT_SLICING_PROGRESS_POLL_INTERVAL_MS
    this.progressHeartbeatIntervalMs = options?.progressHeartbeatIntervalMs ?? DEFAULT_SLICING_PROGRESS_HEARTBEAT_INTERVAL_MS
    this.persistArtifact = options?.persistArtifact ?? persistLibraryFileFromLocalPath
    this.persistThumbnail = options?.persistThumbnail ?? persistHistoryThumbnailFromLibrary
    this.resolveSource = options?.resolveSource ?? resolveSlicingSourcePath

    const persistState = options?.persistState ?? env.NODE_ENV !== 'test'
    this.persistencePath = persistState ? (options?.stateFilePath ?? DEFAULT_SLICING_STATE_FILE) : null
    this.hydrateFromDisk()
    this.recomputeQueuePositions()
    this.pumpQueue()
  }

  list(tenantId: string): SlicingJob[] {
    this.recomputeQueuePositions()
    return Array.from(this.jobs.values())
      .filter((job) => job.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toDto)
  }

  get(tenantId: string, jobId: string): SlicingJob {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
    this.recomputeQueuePositions()
    return toDto(job)
  }

  /**
   * Repoint a job's saved output. Used when saving the output over an existing
   * library file folds it into that row — follow-up actions (e.g. "Print"
   * after saving) must dispatch the surviving file id.
   */
  setOutputFile(tenantId: string, jobId: string, output: { id: string; name: string }): void {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
    job.outputFileId = output.id
    job.outputFileName = output.name
    this.schedulePersist()
  }

  enqueue(input: {
    tenantId: string
    tenant: RequestTenantSummary
    sourceFileId: string
    sourceFileName: string
    sourcePath: string
    targetBridgeId: string | null
    request: CreateSlicingJob
    profileFiles?: ResolvedSlicingProfileFile[]
  }): SlicingJob {
    if (!slicerClient.isConfigured()) {
      throw new HttpError(503, 'Slicer service is not configured')
    }
    const queuedCount = Array.from(this.jobs.values()).filter((job) => job.status === 'queued').length
    if (queuedCount >= env.SLICING_MAX_QUEUED_JOBS) {
      throw conflict('Too many slicing jobs are already queued. Try again after one starts or finishes.')
    }

    const now = new Date()
    const job: SlicingJobState = {
      id: randomUUID(),
      tenantId: input.tenantId,
      tenant: input.tenant,
      sourceFileId: input.sourceFileId,
      sourceFileName: input.sourceFileName,
      sourcePath: input.sourcePath,
      targetBridgeId: input.targetBridgeId,
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
      activeSlicerJobId: null
    }
    this.jobs.set(job.id, job)
    this.logJobEvent(job, 'info', `Queued slicing job for ${job.sourceFileName}`, {
      targetMode: job.request.target.mode,
      plate: job.request.plate,
      profileCount: job.profileFiles.length
    })
    this.recomputeQueuePositions()
    this.pumpQueue()
    this.schedulePersist()
    broadcastSlicingChanged(job.tenantId)
    return toDto(job)
  }

  cancel(tenantId: string, jobId: string): SlicingJob {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
    if (job.status === 'ready' || job.status === 'failed' || job.status === 'cancelled') return toDto(job)
    job.cancelRequested = true
    job.controller?.abort()
    if (job.status === 'queued') {
      this.finish(job, 'cancelled', 'Cancelled before slicing started')
      this.logJobEvent(job, 'warn', 'Cancelled queued slicing job before start')
      this.pumpQueue()
    } else {
      this.touch(job, 'Cancellation requested')
      this.logJobEvent(job, 'warn', 'Cancellation requested for active slicing job')
    }
    this.schedulePersist()
    broadcastSlicingChanged(job.tenantId)
    return toDto(job)
  }

  async delete(tenantId: string, jobId: string): Promise<SlicingJob> {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
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
    broadcastSlicingChanged(job.tenantId)
    return dto
  }

  getThumbnailInfo(tenantId: string, jobId: string): {
    thumbnailPath: string | null
    sourceFileId: string
    outputFileId: string | null
    plate: number
  } {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
    return {
      thumbnailPath: job.thumbnailPath,
      sourceFileId: job.sourceFileId,
      outputFileId: job.outputFileId,
      plate: job.request.plate > 0 ? job.request.plate : 1
    }
  }

  setThumbnailPath(tenantId: string, jobId: string, thumbnailPath: string): void {
    const job = this.jobs.get(jobId)
    if (!job || job.tenantId !== tenantId) throw notFound('Slicing job not found')
    if (job.thumbnailPath === thumbnailPath) return
    job.thumbnailPath = thumbnailPath
    this.schedulePersist()
  }

  private pumpQueue(): void {
    const activeCount = Array.from(this.jobs.values()).filter((job) => job.status === 'preparing' || job.status === 'slicing' || job.status === 'saving').length
    const available = Math.max(0, env.SLICING_MAX_CONCURRENT_JOBS - activeCount)
    if (available === 0) return

    const queued = Array.from(this.jobs.values())
      .filter((job) => job.status === 'queued' && !job.cancelRequested)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, available)

    for (const job of queued) {
      // Claim the slot SYNCHRONOUSLY: run() only flips the status after its first await, so a
      // re-entrant pumpQueue (from enqueue/cancel/finish in the same tick) would otherwise
      // re-select this still-`queued` job and double-run it / overshoot the concurrency cap.
      job.status = 'preparing'
      void this.run(job)
    }
  }

  private async run(job: SlicingJobState): Promise<void> {
    await withTenantRequestContext(job.tenant, async () => {
      const controller = new AbortController()
      const progressController = new AbortController()
      let observedOutputCount = 0
      job.controller = controller
      job.startedAt = new Date()
      this.logJobEvent(job, 'info', 'Starting slicing job execution')
      const progressTracker = this.trackLiveOutput(job, progressController.signal).then((count) => {
        observedOutputCount = count
        return count
      })
      this.setStatus(job, 'preparing', 'Preparing slicer job')
      this.setStatus(job, 'slicing', 'Submitted to slicer service')
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
        // thumbnail reflects the edited layout — BambuStudio's CLI won't regenerate thumbnails
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
          tenantId: job.tenantId,
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
        if (job.cancelRequested || controller.signal.aborted) {
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
        progressController.abort()
        await progressTracker.catch(() => undefined)
        job.controller = null
        job.activeSlicerJobId = null
        this.recomputeQueuePositions()
        this.schedulePersist()
        broadcastSlicingChanged(job.tenantId)
        this.pumpQueue()
      }
    })
  }

  private async runSlicerJob(job: SlicingJobState, signal: AbortSignal) {
    let profileFiles = job.profileFiles
    let request = job.request
    // Re-resolve the source instead of blindly trusting the persisted path: a
    // job re-driven after a restart (or a source delete/replace) may hold a
    // _bridge-cache path that no longer exists. resolveSource re-fetches on
    // demand and fails with a clear message if the source is truly gone.
    let sourcePath = await this.resolveSource({ sourceFileId: job.sourceFileId, sourcePath: job.sourcePath })
    const rewrittenSourcePaths: string[] = []
    const rewrittenKinds = new Set<ResolvedSlicingProfileFile['kind']>()
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
        const imports = resolveSceneEditImports(job.tenantId, sceneEdit)
        const arrangedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-arrange-'))
        const arrangedPath = path.join(arrangedDir, path.basename(job.sourceFileName) || 'source.3mf')
        rewrittenSourcePaths.push(arrangedPath)
        const { replacedObjectIds } = await buildEditedThreeMf(sourcePath, arrangedPath, sceneEdit, imports)
        sourcePath = arrangedPath

        // Per-object PROCESS overrides set in the editor are applied to the arranged 3MF here:
        // the single-plate object-customization path below is skipped whenever an edit is present
        // (it expresses object selection via the edit's printability instead). Overrides for an
        // object replaced via "Replace with…" are re-keyed onto the baked object_id its
        // replacement landed on, so the object's overrides follow the new mesh.
        const editorOverrides = job.request.objectProcessOverrides
        if (editorOverrides && Object.keys(editorOverrides).length > 0) {
          const effectiveOverrides = rekeyReplacedObjectOverrides(editorOverrides, replacedObjectIds)
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
      if (!sceneEdit && job.request.plate > 0 && hasObjectCustomization) {
        const filteredDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-objcustom-'))
        const filteredPath = path.join(filteredDir, path.basename(job.sourceFileName) || 'source.3mf')
        rewrittenSourcePaths.push(filteredPath)
        await createObjectCustomizedThreeMf(sourcePath, filteredPath, job.request.plate, {
          selectedObjectIds: selectedObjectIds && selectedObjectIds.length > 0 ? selectedObjectIds : undefined,
          objectProcessOverrides: objectProcessOverrides && Object.keys(objectProcessOverrides).length > 0 ? objectProcessOverrides : undefined
        })
        sourcePath = filteredPath
      }

      // Heal index-level triangle-soup meshes (older editor imports) before slicing:
      // BambuStudio chains layer contours by vertex index, so unwelded meshes fall into
      // its 2mm gap-closing heuristic and small features (inlaid text) slice mangled.
      // No-op (no copy) for projects whose meshes are already welded, and best-effort
      // overall — a heal failure must never fail a slice that would previously have run.
      {
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

      // Repair mesh geometry the exact-weld heal above can't touch: near-duplicate ("cracked")
      // vertices, and degenerate/duplicate facets. BambuStudio runs this same admesh repair on STL
      // imports but trusts a 3MF's triangles verbatim, so a 3MF built from a cracked mesh reaches
      // the slicer unrepaired. No-op (no copy) when the meshes are already clean, and best-effort —
      // a repair failure must never fail a slice that would previously have run. Runs on the
      // possibly-welded copy from the block above, so the two chain.
      {
        const repairedDir = await mkdtemp(path.join(tmpdir(), 'printstream-slice-repair-'))
        const repairedPath = path.join(repairedDir, path.basename(job.sourceFileName) || 'source.3mf')
        let repairStats: MeshRepairStats | null = null
        try {
          repairStats = await repairThreeMfMeshesToCopy(sourcePath, repairedPath)
        } catch (error) {
          this.logJobEvent(job, 'warn', `Mesh repair pre-pass skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (repairStats) {
          this.logJobEvent(
            job,
            'info',
            `Repaired mesh before slicing: welded ${repairStats.weldedVertices} vertices, ` +
              `dropped ${repairStats.degenerateTrianglesRemoved} degenerate and ${repairStats.duplicateTrianglesRemoved} duplicate triangles`
          )
          rewrittenSourcePaths.push(repairedPath)
          sourcePath = repairedPath
        } else {
          await rm(repairedDir, { recursive: true, force: true }).catch(() => undefined)
        }
      }
      let crashRetryUsed = false
      while (true) {
        const slicerJobId = buildSlicerAttemptJobId(job.id, retryAttempt)
        job.activeSlicerJobId = slicerJobId
        try {
          return await slicerClient.run({
            jobId: slicerJobId,
            sourceFileName: job.sourceFileName,
            sourcePath,
            request,
            profileFiles,
            signal
          })
        } catch (error) {
          // A signal-death exit (segfault et al.) gets ONE retry with unchanged inputs: under
          // qemu emulation the engine crashes intermittently on runs that slice clean when
          // re-run, and a single flake otherwise fails the whole job.
          if (!crashRetryUsed && isTransientSlicerCrashExit(error)) {
            crashRetryUsed = true
            retryAttempt += 1
            const retryMessage = 'Retrying slice after the slicer engine crashed mid-run'
            this.touch(job, retryMessage)
            this.logJobEvent(job, 'warn', retryMessage)
            broadcastSlicingChanged(job.tenantId)
            continue
          }
          const fallbackKinds = collectUnsupportedBuiltinProfileKinds(error)
          if (fallbackKinds.size === 0 && isLikelyBuiltinProfileCompatibilityExit(error)) {
            fallbackKinds.add('machine')
            fallbackKinds.add('process')
          }
          const fallback = await applyBuiltinProfileCompatibilityFallbacks({
            request,
            profileFiles,
            sourcePath,
            fallbackKinds,
            rewrittenKinds
          })
          profileFiles = fallback.profileFiles
          request = fallback.request
          sourcePath = fallback.sourcePath
          rewrittenSourcePaths.push(...fallback.rewrittenSourcePaths)
          const changed = fallback.changed

          if (!changed) {
            throw error
          }

          retryAttempt += 1
          const retryKinds = Array.from(fallbackKinds.values())
          const retryLabel = retryKinds.length === 1 ? retryKinds[0] : retryKinds.join(', ')
          const retryMessage = `Retrying slicer without incompatible built-in ${retryLabel} profile${retryKinds.length === 1 ? '' : 's'}`
          this.touch(job, retryMessage)
          this.logJobEvent(job, 'warn', retryMessage)
          broadcastSlicingChanged(job.tenantId)
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

  private async trackLiveOutput(job: SlicingJobState, signal: AbortSignal): Promise<number> {
    let observedOutputCount = 0
    let lastProgressUpdateAt = Date.now()
    let observedProgressJobId = job.activeSlicerJobId ?? job.id

    while (!signal.aborted) {
      try {
        const progressJobId = job.activeSlicerJobId ?? job.id
        if (progressJobId !== observedProgressJobId) {
          observedProgressJobId = progressJobId
          observedOutputCount = 0
        }
        const output = await slicerClient.progress(progressJobId)
        if (output && output.length > observedOutputCount) {
          this.appendCliOutput(job, output.slice(observedOutputCount))
          observedOutputCount = output.length
          job.updatedAt = new Date()
          lastProgressUpdateAt = Date.now()
          broadcastSlicingChanged(job.tenantId)
        }
      } catch (error) {
        if (!signal.aborted) {
          console.warn(`[slicing:${job.id}] failed to fetch live slicer output`, (error as Error).message)
        }
      }

      if (!signal.aborted && Date.now() - lastProgressUpdateAt >= this.progressHeartbeatIntervalMs) {
        this.appendProgressHeartbeat(job)
        lastProgressUpdateAt = Date.now()
      }

      if (signal.aborted) break
      await delay(this.progressPollIntervalMs, signal)
    }

    return observedOutputCount
  }

  private appendProgressHeartbeat(job: SlicingJobState): void {
    const message = `Slicer is still processing... ${formatElapsedDuration(job.startedAt ?? job.createdAt)} elapsed`
    job.updatedAt = new Date()
    job.output.push({ stream: 'system', text: message, createdAt: job.updatedAt.toISOString() })
    this.schedulePersist()
    broadcastSlicingChanged(job.tenantId)
  }

  private setStatus(job: SlicingJobState, status: SlicingJobStatus, message: string): void {
    job.status = status
    this.touch(job, message)
    this.logJobEvent(job, 'info', `${status}: ${message}`)
    this.recomputeQueuePositions()
    this.schedulePersist()
    broadcastSlicingChanged(job.tenantId)
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

  private touch(job: SlicingJobState, message: string): void {
    job.updatedAt = new Date()
    job.output.push({ stream: 'system', text: message, createdAt: job.updatedAt.toISOString() })
    this.schedulePersist()
  }

  private recomputeQueuePositions(): void {
    const queued = Array.from(this.jobs.values())
      .filter((job) => job.status === 'queued')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    let position = 1
    for (const job of this.jobs.values()) job.queuePosition = null
    for (const job of queued) job.queuePosition = position++
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

function slicedArtifactSavingMessage(request: CreateSlicingJob): string {
  return shouldHideSlicedArtifact(request)
    ? 'Saving sliced artifact for print'
    : 'Saving sliced artifact to the library'
}

function slicedArtifactReadyMessage(request: CreateSlicingJob): string {
  return shouldHideSlicedArtifact(request)
    ? 'Prepared sliced artifact for printing'
    : 'Sliced artifact saved to the library'
}

function serializeSlicingJobState(job: SlicingJobState): PersistedSlicingJobState {
  return {
    id: job.id,
    tenantId: job.tenantId,
    tenant: job.tenant,
    sourceFileId: job.sourceFileId,
    sourceFileName: job.sourceFileName,
    sourcePath: job.sourcePath,
    targetBridgeId: job.targetBridgeId,
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
    cancelRequested: job.cancelRequested
  }
}

function hydratePersistedJob(persisted: PersistedSlicingJobState): SlicingJobState | null {
  if (!persisted || typeof persisted !== 'object') return null
  if (typeof persisted.id !== 'string' || typeof persisted.tenantId !== 'string' || typeof persisted.sourceFileId !== 'string') return null

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
    tenantId: persisted.tenantId,
    tenant: persisted.tenant,
    sourceFileId: persisted.sourceFileId,
    sourceFileName: persisted.sourceFileName,
    sourcePath: persisted.sourcePath,
    targetBridgeId: persisted.targetBridgeId,
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
    activeSlicerJobId: null
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  return new Date(timestamp)
}

async function applyBuiltinProfileCompatibilityFallbacks(input: {
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingProfileFile[]
  sourcePath: string
  fallbackKinds: Set<ResolvedSlicingProfileFile['kind']>
  rewrittenKinds: Set<ResolvedSlicingProfileFile['kind']>
}): Promise<{
  request: CreateSlicingJob
  profileFiles: ResolvedSlicingProfileFile[]
  sourcePath: string
  rewrittenSourcePaths: string[]
  changed: boolean
}> {
  const request = input.request
  let profileFiles = input.profileFiles
  let sourcePath = input.sourcePath
  const rewrittenSourcePaths: string[] = []
  let changed = false

  const nextProfileFiles = profileFiles.filter((profile) => !(profile.source === 'builtin' && input.fallbackKinds.has(profile.kind)))
  if (nextProfileFiles.length !== profileFiles.length) {
    profileFiles = nextProfileFiles
    changed = true
  }

  const sourceRewriteKinds = collectSourceRewriteKinds(input.fallbackKinds, input.rewrittenKinds)
  if (sourceRewriteKinds.size > 0) {
    const rewritten = await rewriteSlicingSourceForFallback(sourcePath, sourceRewriteKinds)
    if (rewritten) {
      sourcePath = rewritten
      rewrittenSourcePaths.push(rewritten)
      for (const kind of sourceRewriteKinds) input.rewrittenKinds.add(kind)
      changed = true
    }
  }

  return { request, profileFiles, sourcePath, rewrittenSourcePaths, changed }
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

function buildDefaultOutputFileName(sourceFileName: string): string {
  return sourceFileName.replace(/\.3mf$/i, '.gcode.3mf')
}

function normalizeOutputFileName(fileName: string): string {
  // Spaces, brackets, and most ASCII punctuation are valid in library/SD file names
  // (BambuStudio itself exports names like "Mount (landscape).gcode.3mf") and are
  // passed to the slicer CLI as a single argv token (no shell word-splitting). Only
  // strip what genuinely breaks downstream: path separators, FAT/firmware-reserved
  // punctuation, and control/non-ASCII characters — matching sanitizeRemoteName.
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

function collectSourceRewriteKinds(
  fallbackKinds: Set<ResolvedSlicingProfileFile['kind']>,
  rewrittenKinds: Set<ResolvedSlicingProfileFile['kind']>
): Set<ResolvedSlicingProfileFile['kind']> {
  const kinds = new Set<ResolvedSlicingProfileFile['kind']>()
  if (fallbackKinds.has('process') && !rewrittenKinds.has('process')) {
    kinds.add('process')
  }
  if (fallbackKinds.has('filament') && !rewrittenKinds.has('filament')) {
    kinds.add('filament')
  }
  if (fallbackKinds.has('machine') && !rewrittenKinds.has('machine')) {
    kinds.add('machine')
  }
  return kinds
}

async function rewriteSlicingSourceForFallback(
  sourcePath: string,
  kinds: Set<ResolvedSlicingProfileFile['kind']>
): Promise<string | null> {
  if (kinds.size === 0) return null
  const rewritten = await rewriteThreeMfProjectSettings(sourcePath, kinds).catch(() => null)
  return rewritten
}

async function rewriteThreeMfProjectSettings(
  sourcePath: string,
  kinds: Set<ResolvedSlicingProfileFile['kind']>
): Promise<string | null> {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'printstream-slicing-source-'))
  const outputPath = path.join(outputDir, 'input.3mf')

  const wrote = await new Promise<boolean>((resolve, reject) => {
    yauzl.open(sourcePath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error('Failed to open 3MF source'))
        return
      }

      const outputZip = new yazl.ZipFile()
      const output = createWriteStream(outputPath)
      let settled = false
      let replaced = false

      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        zipFile.close()
        if (error) {
          output.destroy()
          reject(error)
          return
        }
        resolve(replaced)
      }

      outputZip.outputStream.pipe(output)
      outputZip.outputStream.on('error', finish)
      output.on('error', finish)
      output.on('finish', () => finish())

      zipFile.on('error', finish)
      zipFile.on('end', () => outputZip.end())
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName === 'Metadata/project_settings.config') {
          readZipEntryBuffer(zipFile, entry).then(
            (buffer) => {
              outputZip.addBuffer(
                Buffer.from(sanitizeProjectSettingsConfig(buffer.toString('utf8'), kinds), 'utf8'),
                entry.fileName,
                { mtime: entry.getLastModDate() }
              )
              replaced = true
              zipFile.readEntry()
            },
            finish
          )
          return
        }
        if (entry.fileName.endsWith('/')) {
          outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(streamError ?? new Error(`Failed to read ${entry.fileName}`))
            return
          }
          stream.on('error', finish)
          stream.on('end', () => zipFile.readEntry())
          outputZip.addReadStream(stream, entry.fileName, { mtime: entry.getLastModDate() })
        })
      })

      zipFile.readEntry()
    })
  })

  if (wrote) return outputPath
  await rm(outputPath, { force: true }).catch(() => undefined)
  await rm(outputDir, { recursive: true, force: true }).catch(() => undefined)
  return null
}

function sanitizeProjectSettingsConfig(
  json: string,
  kinds: Set<ResolvedSlicingProfileFile['kind']>
): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return json
  }

  if (!parsed || typeof parsed !== 'object') {
    return json
  }

  const record = parsed as Record<string, unknown>
  if (kinds.has('machine')) {
    record.printer_settings_id = ''
    record.print_compatible_printers = []
  }
  if (kinds.has('process')) {
    record.print_settings_id = ''
    record.default_print_profile = ''
    if (Array.isArray(record.inherits_group) && record.inherits_group.length > 0) {
      const inheritsGroup = [...record.inherits_group]
      inheritsGroup[0] = ''
      record.inherits_group = inheritsGroup
    }
  }
  if (kinds.has('filament')) {
    record.filament_settings_id = []
    record.filament_type = []
    record.filament_colour = []
    record.filament_vendor = []
    record.default_filament_profile = []
  }
  return JSON.stringify(record, null, 2)
}

function readZipEntryBuffer(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Failed to open entry stream'))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
  })
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

function collectUnsupportedBuiltinProfileKinds(error: unknown): Set<ResolvedSlicingProfileFile['kind']> {
  if (!(error instanceof SlicerServiceError)) return new Set()
  const kinds = new Set<ResolvedSlicingProfileFile['kind']>()
  for (const line of error.output) {
    if (line.stream !== 'stderr') continue
    const match =
      line.text.match(/\/(machine|process|filament)_full\//) ??
      line.text.match(/builtin:(machine|process|filament):/i) ??
      line.text.match(/builtin%(?:3a|3A)(machine|process|filament)%(?:3a|3A)/) ??
      line.text.match(/(?:unsupported|incompatible|cannot\s+load|failed\s+to\s+load)[^\n]*\b(machine|process|filament)\b/i)
    if (match?.[1] === 'machine' || match?.[1] === 'process' || match?.[1] === 'filament') {
      kinds.add(match[1])
    }
  }
  return kinds
}

function isLikelyBuiltinProfileCompatibilityExit(error: unknown): boolean {
  if (!(error instanceof SlicerServiceError)) return false
  return /Slicer CLI exited with code 239/i.test(error.message)
}

/**
 * A slicer CLI death by signal — exit 128+N (134 SIGABRT … 139 SIGSEGV) — that is worth ONE retry
 * because it is likely transient. BambuStudio under qemu emulation (arm64 dev/self-host machines)
 * segfaults intermittently during project load/teardown on runs that slice clean when retried, so
 * one bounded retry absorbs the flake.
 *
 * A crash that happened *after the per-plate slice started* is NOT transient — it re-crashes
 * identically every time — and the slicer already reclassifies those into a "The slicing engine
 * crashed …" message (`formatSliceEngineCrashError`) that deliberately does NOT contain the
 * "exited with code 13x" text this predicate matches, so a deterministic engine crash falls through
 * to the failure path (with actionable guidance) instead of burning a futile second full slice.
 */
export function isTransientSlicerCrashExit(error: unknown): boolean {
  if (!(error instanceof SlicerServiceError)) return false
  return /Slicer CLI exited with code 13[4-9]\b/i.test(error.message)
}

export const slicingJobs = new SlicingJobs()
