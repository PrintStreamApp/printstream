/**
 * Resumable chunked upload transport for support-message attachments.
 *
 * Counterpart of `apps/api/src/private/cloud/support/attachment-upload-routes.ts`
 * (begin -> chunks -> complete), used by `useSupportAttachmentDrafts`.
 *
 * Attachments are uploaded in chunks rather than one request because the size
 * cap exceeds what a single request survives: the cloud deployment sits behind
 * a proxy that rejects bodies over 100 MB, and a multi-minute upload has no way
 * to recover from a dropped connection. Each chunk is a short request, and a
 * failed one resumes from the server's authoritative offset instead of
 * restarting the file.
 *
 * Distinct from `chunkedLibraryUpload.ts` on purpose: that transport carries
 * library-specific concerns (bridge-transfer phases, folder placement, a shared
 * cross-upload write budget) that do not apply here. Only the begin/chunk/
 * resume shape is common.
 */
import {
  beginSupportAttachmentUploadResponseSchema,
  extractErrorMessage,
  supportAttachmentChunkResponseSchema,
  supportAttachmentUploadResponseSchema,
  supportAttachmentUploadStatusResponseSchema,
  type SupportAttachment
} from '@printstream/shared'
import { apiFetch } from './apiClient'
import { buildApiUrl } from './apiUrl'
import { readWorkspaceContextHeader } from './workspaceContext'

/**
 * Client-side chunk size. Kept at or below the size the server advertises, and
 * small enough that any single request stays short on a slow connection.
 */
const CLIENT_CHUNK_BYTES = 4 * 1024 * 1024

/** Max attempts per chunk before giving up and surfacing a clear error. */
const MAX_CHUNK_ATTEMPTS = 4

export interface ChunkedSupportAttachmentUploadOptions {
  /** Fraction uploaded, 0..1. Called as each chunk lands. */
  onProgress?: (fraction: number) => void
  /** Abort the upload (cancels in-flight requests and discards the session). */
  signal?: AbortSignal
}

/** True for an aborted-request error, which must propagate instead of retrying. */
export function isSupportUploadAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Carries the HTTP status so the retry loop can decide what is retriable. */
class SupportChunkUploadError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'SupportChunkUploadError'
    this.status = status
  }
}

/**
 * Upload one file and return the attachment it became, ready to be claimed by a
 * message send via `attachmentIds`.
 *
 * `uploadPath` is the surface's attachment base (`/api/support/attachments` or
 * `/api/platform/support/attachments`).
 */
export async function uploadSupportAttachmentInChunks(
  uploadPath: string,
  file: File,
  options: ChunkedSupportAttachmentUploadOptions = {}
): Promise<SupportAttachment> {
  options.signal?.throwIfAborted()

  const started = beginSupportAttachmentUploadResponseSchema.parse(
    await apiFetch(`${uploadPath}/uploads`, {
      method: 'POST',
      signal: options.signal,
      body: {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size
      }
    })
  )

  const sessionUrl = `${uploadPath}/uploads/${encodeURIComponent(started.uploadId)}`
  try {
    // Never exceed what the server accepts per request; prefer the smaller size.
    const chunkSize = Math.min(started.chunkSizeBytes, CLIENT_CHUNK_BYTES)
    let uploadedBytes = started.uploadedBytes
    options.onProgress?.(file.size === 0 ? 1 : uploadedBytes / file.size)

    while (uploadedBytes < file.size) {
      options.signal?.throwIfAborted()
      uploadedBytes = await uploadChunkWithResume({ sessionUrl, file, offset: uploadedBytes, chunkSize, signal: options.signal })
      options.onProgress?.(uploadedBytes / file.size)
    }

    return supportAttachmentUploadResponseSchema.parse(
      await apiFetch(`${sessionUrl}/complete`, { method: 'POST', signal: options.signal, body: {} })
    ).attachment
  } catch (error) {
    // Abandon the server-side session so its partial bytes are reclaimed now
    // rather than at the TTL sweep. A fresh, un-aborted request: the caller's
    // signal may be the very reason we are here.
    await apiFetch(sessionUrl, { method: 'DELETE' }).catch(() => undefined)
    throw error
  }
}

interface ChunkResumeParams {
  sessionUrl: string
  file: File
  offset: number
  chunkSize: number
  signal?: AbortSignal
}

/**
 * Upload a single chunk, retrying transient failures with exponential backoff.
 * Before each retry it re-reads the server's authoritative `receivedBytes` and
 * re-slices from there, which also recovers the case where a chunk landed but
 * its acknowledgement was lost. Returns the new total uploaded byte count.
 */
async function uploadChunkWithResume(params: ChunkResumeParams): Promise<number> {
  let currentOffset = params.offset
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt += 1) {
    params.signal?.throwIfAborted()
    const end = Math.min(params.file.size, currentOffset + params.chunkSize)
    const chunk = params.file.slice(currentOffset, end)
    try {
      const result = await uploadChunk(params.sessionUrl, currentOffset, chunk, params.signal)
      return result.uploadedBytes
    } catch (error) {
      // A cancelled upload must abort immediately, not consume retries.
      if (isSupportUploadAbortError(error)) throw error
      lastError = error
      const status = error instanceof SupportChunkUploadError ? error.status : null
      // 409 is an offset mismatch, which the re-read below resolves.
      const retriable = status === null || status === 408 || status === 409 || status === 429 || status >= 500
      if (!retriable || attempt >= MAX_CHUNK_ATTEMPTS) break
      await delay(retryDelayMs(attempt))
      const serverOffset = await fetchReceivedBytes(params.sessionUrl)
      if (serverOffset !== null) {
        if (serverOffset >= params.file.size) return serverOffset
        currentOffset = serverOffset
      }
    }
  }
  throw new Error(`Upload was interrupted and could not resume: ${extractErrorMessage(lastError, 'connection lost')}`)
}

/** The server's authoritative received byte count for resume, or null if unreachable. */
async function fetchReceivedBytes(sessionUrl: string): Promise<number | null> {
  try {
    const status = supportAttachmentUploadStatusResponseSchema.parse(await apiFetch(sessionUrl))
    return status.receivedBytes
  } catch {
    return null
  }
}

/** Exponential backoff with a ceiling, in milliseconds. */
function retryDelayMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1))
}

async function uploadChunk(
  sessionUrl: string,
  offset: number,
  chunk: Blob,
  signal?: AbortSignal
): Promise<{ uploadedBytes: number; complete: boolean }> {
  const workspaceContext = readWorkspaceContextHeader()
  // Raw fetch rather than apiFetch: the body is bytes, not JSON.
  const response = await fetch(buildApiUrl(`${sessionUrl}/chunks`), {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      'X-Upload-Offset': String(offset),
      ...(workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {})
    },
    body: chunk
  })
  const payload = await parsePayload(response)
  if (!response.ok) {
    throw new SupportChunkUploadError(extractErrorMessage(payload, `Upload failed (${response.status})`), response.status)
  }
  return supportAttachmentChunkResponseSchema.parse(payload)
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}
