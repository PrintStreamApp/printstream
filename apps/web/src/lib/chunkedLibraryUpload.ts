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
 * stays as the final safety net — the budget is shared with other tabs and
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
  // headers.get() returns null when absent, and Number(null) is 0 — parse
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
async function acquireUploadWriteSlot(onWait?: () => void): Promise<void> {
  for (;;) {
    const budget = serverWriteBudget
    if (budget) {
      if (Date.now() >= budget.resetAtMs) {
        // The server's window rolled over: assume a full budget and a fresh
        // window (the limiter uses 60s windows); the next response corrects us.
        budget.remaining = budget.limit
        budget.resetAtMs = Date.now() + 60_000
      }
      if (budget.remaining > WRITE_BUDGET_RESERVE) {
        // Optimistically consume a slot; responses overwrite with the truth.
        budget.remaining -= 1
        return
      }
      onWait?.()
      await delay(Math.max(budget.resetAtMs - Date.now(), 0) + 250)
      continue
    }

    // No server signal yet: conservative client-side sliding window.
    const now = Date.now()
    while (uploadWriteTimestamps.length > 0 && (uploadWriteTimestamps[0] ?? 0) <= now - UPLOAD_WRITE_WINDOW_MS) {
      uploadWriteTimestamps.shift()
    }
    if (uploadWriteTimestamps.length < UPLOAD_WRITES_PER_MINUTE) {
      uploadWriteTimestamps.push(now)
      return
    }
    onWait?.()
    await delay((uploadWriteTimestamps[0] ?? now) + UPLOAD_WRITE_WINDOW_MS - now + 50)
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
async function pacedUploadWrite<T>(run: () => Promise<T>, onWait?: () => void): Promise<T> {
  for (let waits = 0; ; waits += 1) {
    await acquireUploadWriteSlot(onWait)
    try {
      return await run()
    } catch (error) {
      const waitSeconds = rateLimitWaitSeconds(error)
      if (waitSeconds === null || waits >= MAX_RATE_LIMIT_WAITS) throw error
      onWait?.()
      await delay((waitSeconds + 1) * 1000)
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
    phase: 'receiving' | 'transferring' | 'finalizing'
    sizeBytes: number
    receivedBytes: number
    bridgeReceivedBytes: number
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
  onProgress?: (progress: ChunkedLibraryUploadProgress) => void
}

export async function uploadLibraryFileInChunks(
  file: File,
  options: ChunkedLibraryUploadOptions = {}
): Promise<{ file: LibraryFile }> {
  const started = await pacedUploadWrite(
    () => apiFetch<BeginUploadResponse>('/api/library/uploads', {
      method: 'POST',
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
    () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes: 0, totalBytes: file.size })
  )

  try {
    // Respect the server's advertised maximum but prefer the smaller client size.
    const chunkSize = Math.min(started.chunkSizeBytes, CLIENT_CHUNK_BYTES)
    let uploadedBytes = started.uploadedBytes
    options.onProgress?.({ phase: 'uploading-to-server', uploadedBytes, totalBytes: file.size })

    while (uploadedBytes < file.size) {
      uploadedBytes = await uploadChunkWithResume({
        uploadId: started.uploadId,
        file,
        offset: uploadedBytes,
        chunkSize,
        onRateLimitWait: () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes, totalBytes: file.size })
      })
      options.onProgress?.({ phase: 'uploading-to-server', uploadedBytes, totalBytes: file.size })
    }

    options.onProgress?.({ phase: 'sending-to-bridge', uploadedBytes: 0, totalBytes: file.size })
    const poller = startUploadStatusPolling(started.uploadId, options)
    try {
      return await pacedUploadWrite(
        () => apiFetch<{ file: LibraryFile }>(`/api/library/uploads/${encodeURIComponent(started.uploadId)}/complete`, {
          method: 'POST',
          body: {},
          onResponseHeaders: recordUploadWriteBudget
        }),
        () => options.onProgress?.({ phase: 'waiting-for-server', uploadedBytes: file.size, totalBytes: file.size })
      )
    } finally {
      poller.stop()
      await poller.done
    }
  } catch (error) {
    await apiFetch(`/api/library/uploads/${encodeURIComponent(started.uploadId)}`, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

function startUploadStatusPolling(uploadId: string, options: ChunkedLibraryUploadOptions): { stop: () => void; done: Promise<void> } {
  let stopped = false
  return {
    stop: () => {
      stopped = true
    },
    done: (async () => {
      while (!stopped) {
        await delay(500)
        if (stopped) return
        try {
          const status = await apiFetch<UploadStatusResponse>(`/api/library/uploads/${encodeURIComponent(uploadId)}`)
          options.onProgress?.(mapStatusToProgress(status))
        } catch {
          return
        }
      }
    })()
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
  return {
    phase: 'uploading-to-server',
    uploadedBytes: status.upload.receivedBytes,
    totalBytes: status.upload.sizeBytes
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

interface ChunkResumeParams {
  uploadId: string
  file: File
  offset: number
  chunkSize: number
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
    const end = Math.min(file.size, currentOffset + params.chunkSize)
    const chunk = file.slice(currentOffset, end)
    try {
      // 429s wait out the server's window here (pacing) rather than burning
      // the bounded failure retries below.
      const result = await pacedUploadWrite(
        () => uploadChunk(uploadId, currentOffset, chunk),
        params.onRateLimitWait
      )
      return result.uploadedBytes
    } catch (error) {
      lastError = error
      const status = error instanceof ChunkUploadError ? error.status : null
      const retriable = status === null || status === 408 || status === 409 || status === 429 || status >= 500
      if (!retriable || attempt >= MAX_CHUNK_ATTEMPTS) break
      await delay(retryDelayMs(attempt))
      const serverOffset = await fetchReceivedBytes(uploadId)
      if (serverOffset !== null) {
        if (serverOffset >= file.size) return serverOffset
        currentOffset = serverOffset
      }
    }
  }
  throw new Error(`Upload was interrupted and could not resume: ${extractErrorMessage(lastError, 'connection lost')}`)
}

/** Reads the server's authoritative received byte count for resume, or null if unreachable. */
async function fetchReceivedBytes(uploadId: string): Promise<number | null> {
  try {
    const status = await apiFetch<UploadStatusResponse>(`/api/library/uploads/${encodeURIComponent(uploadId)}`)
    return status.upload.receivedBytes
  } catch {
    return null
  }
}

/** Exponential backoff with a ceiling, in milliseconds. */
function retryDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1))
}

async function uploadChunk(uploadId: string, offset: number, chunk: Blob): Promise<ChunkUploadResponse> {
  const workspaceContext = readWorkspaceContextHeader()
  const response = await fetch(buildApiUrl(`/api/library/uploads/${encodeURIComponent(uploadId)}/chunks`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-Upload-Offset': String(offset),
      ...(workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {})
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
