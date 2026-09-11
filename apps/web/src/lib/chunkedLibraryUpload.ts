/**
 * Resumable chunked upload transport for library files. Splits a file into
 * client-sized chunks (begin / chunk / complete against `/api/library/uploads`),
 * paces write requests against the server-advertised `RateLimit-*` budget shared
 * across this tab's concurrent uploads, retries transient failures by re-reading
 * the server's authoritative received-byte offset, and polls upload status to
 * report bridge-transfer/finalize progress. The low-level transport; most flows
 * go through `enqueueLibraryUploads` instead.
 */
import { extractErrorMessage, type LibraryFile } from '@printstream/shared'
import { ApiError, apiFetch, parseRetryAfterSeconds } from './apiClient'
import { buildApiUrl } from './apiUrl'
import { readWorkspaceContextHeader } from './workspaceContext'

/**
 * Client-side chunk size. Deliberately smaller than the API's per-request
 * `express.raw` limit so large files split into several short requests: this
 * gives real progress, keeps any single request short enough to survive flaky
 * mobile/proxy connections, and lets a dropped chunk resume instead of
 * restarting the whole upload. We never exceed the size the server advertises.
 */
const CLIENT_CHUNK_BYTES = 4 * 1024 * 1024

/** Max attempts per chunk before giving up and surfacing a clear error. */
const MAX_CHUNK_ATTEMPTS = 4

/**
 * Max times a single request waits out a rate-limit window before giving up.
 * Each wait spans the server's full Retry-After, so this only trips when the
 * budget is persistently exhausted by something other than this upload queue.
 */
const MAX_RATE_LIMIT_WAITS = 10

/** Fallback pause when a 429 arrives without a usable Retry-After header. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5
/** Bound a completion attempt; an uncertain outcome is reconciled through upload status. */
const COMPLETE_REQUEST_TIMEOUT_MS = 20_000
const RECONCILE_REQUEST_TIMEOUT_MS = 10_000
const RECONCILE_POLL_MS = 1_000
const RECONCILE_DEADLINE_MS = 2 * 60_000

/**
 * Proactive pacing for upload write requests (begin/chunk/complete), shared by
 * every concurrent upload in this tab.
 *
 * The server advertises its real per-user write budget via `RateLimit-*`
 * headers on every upload response; we track the latest snapshot and pause
 * before the budget runs dry, leaving `WRITE_BUDGET_RESERVE` requests of
 * headroom for the rest of the app. Until the first snapshot arrives (or
 * against an older server without the headers) a conservative client-side
 * sliding window applies instead. The reactive Retry-After handling below
 * stays as the final safety net: the budget is shared with other tabs and
 * devices whose spending we only see when our own responses report it.
 */
const UPLOAD_WRITES_PER_MINUTE = 90
const UPLOAD_WRITE_WINDOW_MS = 60_000
const uploadWriteTimestamps: number[] = []

/** Write requests left for the rest of the app when uploads pause. */
const WRITE_BUDGET_RESERVE = 10

interface ServerWriteBudget {
  limit: number
  remaining: number
  resetAtMs: number
}

let serverWriteBudget: ServerWriteBudget | null = null

/** Refresh the budget snapshot from a response's RateLimit headers. */
function recordUploadWriteBudget(headers: Headers): void {
  // headers.get() returns null when absent, and Number(null) is 0: parse
  // each header explicitly so a header-less response never records a
  // zero-budget snapshot (which would stall the queue forever).
  const limit = parsePositiveHeaderNumber(headers.get('RateLimit-Limit'))
  const remaining = parseHeaderNumber(headers.get('RateLimit-Remaining'))
  const resetSeconds = parseHeaderNumber(headers.get('RateLimit-Reset'))
  if (limit === null || remaining === null || resetSeconds === null) return
  serverWriteBudget = {
    limit,
    remaining,
    resetAtMs: Date.now() + Math.max(resetSeconds, 0) * 1000
  }
}

function parseHeaderNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parsePositiveHeaderNumber(value: string | null): number | null {
  const parsed = parseHeaderNumber(value)
  return parsed !== null && parsed >= 1 ? parsed : null
}

/** Resolve when a write slot is free, recording the slot as taken. */
async function acquireUploadWriteSlot(
  onWait?: () => void,
  signal?: AbortSignal,
  reserve = WRITE_BUDGET_RESERVE
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted()
    const budget = serverWriteBudget
    if (budget) {
      if (Date.now() >= budget.resetAtMs) {
        // The server's window rolled over: assume a full budget and a fresh
        // window (the limiter uses 60s windows); the next response corrects us.
        budget.remaining = budget.limit
        budget.resetAtMs = Date.now() + 60_000
      }
      if (budget.remaining > reserve) {
        // Optimistically consume a slot; responses overwrite with the truth.
        budget.remaining -= 1
        return
      }
      onWait?.()
      await abortableDelay(Math.max(budget.resetAtMs - Date.now(), 0) + 250, signal)
      continue
    }

    // No server signal yet: conservative client-side sliding window.
    const now = Date.now()
    while (uploadWriteTimestamps.length > 0 && (uploadWriteTimestamps[0] ?? 0) <= now - UPLOAD_WRITE_WINDOW_MS) {
      uploadWriteTimestamps.shift()
    }
    if (uploadWriteTimestamps.length < Math.max(1, UPLOAD_WRITES_PER_MINUTE - reserve)) {
      uploadWriteTimestamps.push(now)
      return
    }
    onWait?.()
    await abortableDelay((uploadWriteTimestamps[0] ?? now) + UPLOAD_WRITE_WINDOW_MS - now + 50, signal)
  }
}

/** Carries the HTTP status (when known) so the retry loop can decide what is retriable. */
class ChunkUploadError extends Error {
  readonly status: number | null
  readonly retryAfterSeconds: number | null
  constructor(message: string, status: number | null, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'ChunkUploadError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Seconds to pause for a rate-limit error, or null when the error is anything else. */
function rateLimitWaitSeconds(error: unknown): number | null {
  if (error instanceof ApiError && error.status === 429) {
    return error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS
  }
  if (error instanceof ChunkUploadError && error.status === 429) {
    return error.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS
  }
  return null
}

/**
 * Run an upload write request with rate-limit pacing on both ends: a write
 * slot is acquired from the client-side ceiling first (so the queue throttles
 * itself instead of brute-forcing the server), and any 429 that still slips
 * through waits out the server's Retry-After and retries instead of failing.
 */
async function pacedUploadWrite<T>(
  run: () => Promise<T>,
  onWait?: () => void,
  options: { signal?: AbortSignal; reserve?: number } = {}
): Promise<T> {
  for (let waits = 0; ; waits += 1) {
    await acquireUploadWriteSlot(onWait, options.signal, options.reserve)
    try {
      return await run()
    } catch (error) {
      const waitSeconds = rateLimitWaitSeconds(error)
      if (waitSeconds === null || waits >= MAX_RATE_LIMIT_WAITS) throw error
      onWait?.()
      await abortableDelay((waitSeconds + 1) * 1000, options.signal)
    }
  }
}

interface BeginUploadResponse {
  uploadId: string
  chunkSizeBytes: number
  uploadedBytes: number
}

interface ChunkUploadResponse {
  uploadedBytes: number
  complete: boolean
}

interface UploadStatusResponse {
  upload: {
    phase: 'receiving' | 'transferring' | 'finalizing' | 'completed'
    sizeBytes: number
    receivedBytes: number
    bridgeReceivedBytes: number
    completion: StoredUploadCompletion | null
  }
}

export type ChunkedLibraryUploadPhase = 'uploading-to-server' | 'sending-to-bridge' | 'finalizing' | 'waiting-for-server'

export interface ChunkedLibraryUploadProgress {
  phase: ChunkedLibraryUploadPhase
  uploadedBytes: number
  totalBytes: number
}

export interface ChunkedLibraryUploadOptions {
  folderId?: string | null
  bridgeId?: string | null
  hidden?: boolean
  /**
   * Folder chain (relative to `folderId`) the file should land in. Used by
   * folder-structure uploads; the API creates any missing folders on completion.
   */
  relativeFolderPath?: string[]
  /**
   * Version THIS file rather than whichever one the name happens to match.
   *
   * The editor knows the row it is saving a new version of. Name matching cannot express that: a
   * project renamed or moved since it was opened would be saved as a SECOND file instead of a
   * version. The addressed row keeps its own name and folder, since a save is neither a rename nor
   * a move, and a target that no longer resolves is an error rather than a new file.
   */
  targetFileId?: string | null
  /**
   * Stage the bytes as a hidden, content-deduped snapshot instead of saving them.
   *
   * How a slice of UNSAVED editor work reaches the slicer: the bytes have to be addressable, but
   * the user's project must not gain a version. Creates no version and touches no project;
   * `pruneUnreferencedProjectSnapshots` reclaims the row if nothing ends up referencing it.
   */
  snapshot?: boolean
  /** Server-recorded proof that this snapshot is a complete browser-authored slicing input. */
  preparedSlicing?: {
    contractVersion: 1
    sourceFileId: string
    slicerTargetId?: string | null
    configurationBaseVersionId?: string | null
    target: import('@printstream/shared').SlicingTarget
  }
  onProgress?: (progress: ChunkedLibraryUploadProgress) => void
  /**
   * Called immediately before upload completion begins.
   *
   * Completion can transfer the bytes to a bridge and commit a library version. From this point
   * onward cancellation is deliberately locked: aborting the HTTP request cannot prove that the
   * server did not commit, and reporting a cancellation after it did would leave the caller's
   * local state behind the saved file.
   */
  onCommitStart?: () => void
  /**
   * Called when the completion response is uncertain and authoritative polling takes over.
   * `stopWaiting` leaves the possibly-completed server operation alone and only releases the UI.
   */
  onReconciliationStart?: (stopWaiting: () => void) => void
  /**
   * Called after bounded reconciliation could not establish an outcome. Invoking `retry` starts
   * another bounded status check for this same upload id; it never uploads the bytes again.
   */
  onReconciliationRequired?: (retry: () => void, message: string, stopWaiting: () => void) => void
  /** Abort the upload before completion begins (cancels requests and discards the session). */
  signal?: AbortSignal
}

/** What the complete step answers, before the caller's defaults are applied. */
interface CompleteUploadResponse {
  file: LibraryFile
  unchanged?: boolean
  archivedVersionId?: string | null
  snapshot?: boolean
  preparedSourceId?: string | null
}

interface StoredUploadCompletion {
  statusCode: 201
  body: CompleteUploadResponse
}

/** The result of a completed upload. */
export interface UploadedLibraryFile {
  file: LibraryFile
  /** The server saw byte-identical content and created no version. */
  unchanged: boolean
  /**
   * The version this write archived, i.e. the content that was current until now.
   *
   * Null when nothing was archived: a new file, a snapshot, or an unchanged upload.
   */
  archivedVersionId: string | null
  /** This landed as a hidden staged snapshot rather than as a save. */
  snapshot: boolean
  /** Opaque server-issued preparation id, present only for a prepared slicing snapshot. */
  preparedSourceId: string | null
}

/** True for an aborted-request error, which must propagate instead of retrying. */
export function isUploadAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export async function uploadLibraryFileInChunks(
  file: File,
  options: ChunkedLibraryUploadOptions = {}
): Promise<UploadedLibraryFile> {
  options.signal?.throwIfAborted()
  const started = await pacedUploadWrite(
    () => apiFetch<BeginUploadResponse>('/api/library/uploads', {
      method: 'POST',
      signal: options.signal,
      body: {
        fileName: file.name,
        sizeBytes: file.size,
        folderId: options.folderId ?? null,
        bridgeId: options.bridgeId ?? null,
        hidden: options.hidden ?? false,
        ...(options.relativeFolderPath?.length ? { relativeFolderPath: options.relativeFolderPath } : {})
      },
      onResponseHeaders: recordUploadWriteBudget
    }),
    () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes: 0, totalBytes: file.size }),
    { signal: options.signal }
  )

  let completionStarted = false
  try {
    // Respect the server's advertised maximum but prefer the smaller client size.
    const chunkSize = Math.min(started.chunkSizeBytes, CLIENT_CHUNK_BYTES)
    let uploadedBytes = started.uploadedBytes
    options.onProgress?.({ phase: 'uploading-to-server', uploadedBytes, totalBytes: file.size })

    while (uploadedBytes < file.size) {
      options.signal?.throwIfAborted()
      uploadedBytes = await uploadChunkWithResume({
        uploadId: started.uploadId,
        file,
        offset: uploadedBytes,
        chunkSize,
        signal: options.signal,
        onRateLimitWait: () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes, totalBytes: file.size })
      })
      options.onProgress?.({ phase: 'uploading-to-server', uploadedBytes, totalBytes: file.size })
    }

    options.onProgress?.({ phase: 'sending-to-bridge', uploadedBytes: 0, totalBytes: file.size })
    const poller = startUploadStatusPolling(started.uploadId, options)
    try {
      const completionBody = {
        ...(options.targetFileId ? { targetFileId: options.targetFileId } : {}),
        ...(options.snapshot ? { snapshot: true } : {}),
        ...(options.preparedSlicing ? { preparedSlicing: options.preparedSlicing } : {})
      }
      const runCompletion = () => {
        // The rate-limit wait above is still cancellable. Lock only at the exact boundary where
        // the POST starts, then omit the signal: a response can be aborted after the server has
        // committed, which is not a cancellation the client is allowed to report.
        if (!completionStarted) {
          options.signal?.throwIfAborted()
          options.onCommitStart?.()
          completionStarted = true
        }
        return apiFetch<CompleteUploadResponse>(`/api/library/uploads/${encodeURIComponent(started.uploadId)}/complete`, {
          method: 'POST',
          timeoutMs: COMPLETE_REQUEST_TIMEOUT_MS,
          // Both ride the COMPLETE step rather than the begin: neither describes the bytes, and a
          // caller that changes its mind mid-transfer must not have to restart the upload.
          body: completionBody,
          onResponseHeaders: recordUploadWriteBudget
        })
      }
      let result: CompleteUploadResponse
      try {
        result = await pacedUploadWrite(
          runCompletion,
          () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes: file.size, totalBytes: file.size }),
          // The final request should use the headroom the upload deliberately reserved. Otherwise
          // a completed transfer can sit idle until the write-rate window resets before saving.
          { signal: options.signal, reserve: 0 }
        )
      } catch (error) {
        if (!isUncertainCompletionError(error)) throw error
        const reconciliationAbort = new AbortController()
        const stopWaiting = () => reconciliationAbort.abort()
        options.onReconciliationStart?.(stopWaiting)
        result = await reconcileUploadCompletion(
          started.uploadId,
          runCompletion,
          options,
          reconciliationAbort.signal,
          stopWaiting
        )
      }
      return {
        file: result.file,
        unchanged: result.unchanged ?? false,
        archivedVersionId: result.archivedVersionId ?? null,
        snapshot: result.snapshot ?? false,
        preparedSourceId: result.preparedSourceId ?? null
      }
    } finally {
      poller.stop()
      await poller.done
    }
  } catch (error) {
    // Before completion, abandoning a cancelled/failed upload is safe. Once completion starts,
    // DELETE would race a server operation that may already have committed, so retain the session
    // for the server's normal cleanup unless a future reconciliation endpoint proves otherwise.
    if (!completionStarted) {
      await apiFetch(`/api/library/uploads/${encodeURIComponent(started.uploadId)}`, { method: 'DELETE' }).catch(() => undefined)
    }
    throw error
  }
}

/** Resolve an uncertain completion from the server's retained authoritative result. */
async function reconcileUploadCompletion(
  uploadId: string,
  retryCompletion: () => Promise<CompleteUploadResponse>,
  options: ChunkedLibraryUploadOptions,
  signal: AbortSignal,
  stopWaiting: () => void
): Promise<CompleteUploadResponse> {
  let startedAt = Date.now()
  for (;;) {
    signal.throwIfAborted()
    try {
      const status = await apiFetch<UploadStatusResponse>(`/api/library/uploads/${encodeURIComponent(uploadId)}`, {
        timeoutMs: RECONCILE_REQUEST_TIMEOUT_MS,
        signal
      })
      options.onProgress?.(mapStatusToProgress(status))
      if (status.upload.completion) return status.upload.completion.body
      // Replay whenever no authoritative result exists. A process can restart after persisting the
      // transferring/finalizing phase and pending receipt but before its in-memory completion work
      // survives. The server serializes by upload id and verifies the durable intent digest, so the
      // same request either waits for live work or resumes that orphaned operation safely.
      if (status.upload.phase !== 'completed') {
        try {
          return await retryCompletion()
        } catch (error) {
          signal.throwIfAborted()
          if (!isUncertainCompletionError(error)) throw error
        }
      }
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ApiError) {
        if (error.status === 404) {
          await waitForReconciliationRetry(
            options,
            'The server no longer has this upload result. Check the Library, or retry the status check.',
            stopWaiting
          )
          startedAt = Date.now()
          continue
        }
        if (!isUncertainCompletionError(error)) throw error
      }
      // A transient status failure says nothing about whether completion committed. Keep polling;
      // the retained result is the only source allowed to decide the outcome.
    }
    if (uploadReconciliationDeadlineReached(startedAt, Date.now())) {
      await waitForReconciliationRetry(
        options,
        'The server did not confirm the upload result in time. Check the Library, or retry the status check.',
        stopWaiting
      )
      startedAt = Date.now()
    }
    await delay(RECONCILE_POLL_MS)
    signal.throwIfAborted()
  }
}

/** HTTP/network outcomes that cannot prove whether the completion request committed. */
export function isUncertainCompletionError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true
  return error.status === 408 || error.status === 429 || error.status >= 500
}

async function waitForReconciliationRetry(
  options: ChunkedLibraryUploadOptions,
  message: string,
  stopWaiting: () => void
): Promise<void> {
  if (!options.onReconciliationRequired) throw new Error(message)
  await new Promise<void>((resolve, reject) => options.onReconciliationRequired?.(
    resolve,
    message,
    () => reject(new DOMException('Stopped checking upload status.', 'AbortError'))
  ))
  options.onReconciliationStart?.(stopWaiting)
}

/** Pure deadline rule shared with regression coverage for orphaned server sessions. */
export function uploadReconciliationDeadlineReached(startedAt: number, now: number): boolean {
  return now - startedAt >= RECONCILE_DEADLINE_MS
}

function startUploadStatusPolling(uploadId: string, options: ChunkedLibraryUploadOptions): { stop: () => void; done: Promise<void> } {
  let stopped = false
  const stopController = new AbortController()
  const onCallerAbort = () => stopController.abort(options.signal?.reason)
  if (options.signal?.aborted) onCallerAbort()
  else options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const done = (async () => {
    try {
      while (!stopped && !options.signal?.aborted) {
        await delay(500)
        if (stopped || options.signal?.aborted) return
        try {
          const status = await apiFetch<UploadStatusResponse>(`/api/library/uploads/${encodeURIComponent(uploadId)}`, {
            signal: stopController.signal,
            timeoutMs: RECONCILE_REQUEST_TIMEOUT_MS
          })
          options.onProgress?.(mapStatusToProgress(status))
        } catch {
          if (stopped || stopController.signal.aborted) return
          // Progress polling is advisory. A transient failure must neither fail the upload nor
          // permanently freeze the last progress frame while completion continues.
        }
      }
    } finally {
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  })()
  return {
    stop: () => {
      stopped = true
      // A proxy can wedge a status GET indefinitely. Stopping must abort that request so a
      // successful completion is never held open while `finally` awaits the poller.
      stopController.abort()
    },
    done
  }
}

function mapStatusToProgress(status: UploadStatusResponse): ChunkedLibraryUploadProgress {
  if (status.upload.phase === 'transferring') {
    return {
      phase: 'sending-to-bridge',
      uploadedBytes: status.upload.bridgeReceivedBytes,
      totalBytes: status.upload.sizeBytes
    }
  }
  if (status.upload.phase === 'finalizing') {
    return {
      phase: 'finalizing',
      uploadedBytes: status.upload.sizeBytes,
      totalBytes: status.upload.sizeBytes
    }
  }
  if (status.upload.phase === 'completed') {
    return {
      phase: 'finalizing',
      uploadedBytes: status.upload.sizeBytes,
      totalBytes: status.upload.sizeBytes
    }
  }
  return {
    // A complete browser upload that is still marked receiving means the completion request is
    // waiting to begin. Never regress the UI to a frozen 100% browser-transfer bar.
    phase: status.upload.receivedBytes >= status.upload.sizeBytes ? 'waiting-for-server' : 'uploading-to-server',
    uploadedBytes: status.upload.receivedBytes,
    totalBytes: status.upload.sizeBytes
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/** A pacing wait is still pre-commit work, so Cancel must interrupt it immediately. */
async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!signal) {
    await delay(milliseconds)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

interface ChunkResumeParams {
  uploadId: string
  file: File
  offset: number
  chunkSize: number
  signal?: AbortSignal
  /** Invoked when a chunk pauses to wait out a rate-limit window. */
  onRateLimitWait?: () => void
}

/**
 * Uploads a single chunk, retrying transient failures (network drops, 408/429,
 * 5xx, and offset conflicts) with exponential backoff. Before each retry it
 * re-reads the server's authoritative `receivedBytes` and re-slices from there,
 * which also recovers the case where a chunk landed but its acknowledgement was
 * lost. Returns the new total uploaded byte count.
 */
async function uploadChunkWithResume(params: ChunkResumeParams): Promise<number> {
  const { uploadId, file } = params
  let currentOffset = params.offset
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    params.signal?.throwIfAborted()
    const end = Math.min(file.size, currentOffset + params.chunkSize)
    const chunk = file.slice(currentOffset, end)
    try {
      // 429s wait out the server's window here (pacing) rather than burning
      // the bounded failure retries below.
      const result = await pacedUploadWrite(
        () => uploadChunk(uploadId, currentOffset, chunk, params.signal),
        params.onRateLimitWait,
        { signal: params.signal }
      )
      return result.uploadedBytes
    } catch (error) {
      // A cancelled upload must abort immediately, not consume retries.
      if (isUploadAbortError(error)) throw error
      lastError = error
      const status = error instanceof ChunkUploadError ? error.status : null
      const retriable = status === null || status === 408 || status === 409 || status === 429 || status >= 500
      if (!retriable || attempt >= MAX_CHUNK_ATTEMPTS) break
      await abortableDelay(retryDelayMs(attempt), params.signal)
      const serverOffset = await fetchReceivedBytes(uploadId, params.signal)
      if (serverOffset !== null) {
        if (serverOffset >= file.size) return serverOffset
        currentOffset = serverOffset
      }
    }
  }
  throw new Error(`Upload was interrupted and could not resume: ${extractErrorMessage(lastError, 'connection lost')}`)
}

/** Reads the server's authoritative received byte count for resume, or null if unreachable. */
async function fetchReceivedBytes(uploadId: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const status = await apiFetch<UploadStatusResponse>(`/api/library/uploads/${encodeURIComponent(uploadId)}`, { signal })
    return status.upload.receivedBytes
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

/** Exponential backoff with a ceiling, in milliseconds. */
function retryDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1))
}

async function uploadChunk(uploadId: string, offset: number, chunk: Blob, signal?: AbortSignal): Promise<ChunkUploadResponse> {
  const workspaceContext = readWorkspaceContextHeader()
  const response = await fetch(buildApiUrl(`/api/library/uploads/${encodeURIComponent(uploadId)}/chunks`), {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-Upload-Offset': String(offset),
      ...(workspaceContext ? { 'X-PrintStream-Workspace': workspaceContext } : {})
    },
    body: chunk
  })
  recordUploadWriteBudget(response.headers)
  const payload = await parsePayload(response)
  if (!response.ok) {
    throw new ChunkUploadError(
      extractErrorMessage(payload, `Upload failed (${response.status})`),
      response.status,
      parseRetryAfterSeconds(response)
    )
  }
  return payload as ChunkUploadResponse
}

async function parsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return ''
    }
  }
  return await response.text()
}
