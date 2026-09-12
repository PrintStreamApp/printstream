/** Resumable transport and token-protected polling for anonymous slicing jobs. */
import type { PublicSlicingExecutionRequest, PublicSlicingJob, SlicingOutputLine } from '@printstream/shared'
import { apiFetch } from '../../../lib/apiClient'
import { apiFetchRaw, readApiErrorMessage } from '../../../lib/apiFetchRaw'

const CHUNK_BYTES = 3 * 1024 * 1024

export interface PublicSlicingSession {
  job: PublicSlicingJob
  accessToken: string
}

type PublicSlicingAccess = {
  accessToken: string
  job: Pick<PublicSlicingJob, 'id'>
}

/** Create, upload, validate, and queue one already-prepared project. */
export async function submitPublicSlice(
  bytes: Uint8Array,
  fileName: string,
  request: PublicSlicingExecutionRequest,
  signal: AbortSignal,
  onProgress: (uploadedBytes: number, totalBytes: number) => void,
  onSession?: (session: PublicSlicingSession) => void
): Promise<PublicSlicingSession> {
  const created = await apiFetch<{ job: PublicSlicingJob; accessToken: string; uploadOffset: number }>(
    '/api/public/slicing/jobs',
    { method: 'POST', body: { fileName, sizeBytes: bytes.byteLength }, signal }
  )
  onSession?.({ job: created.job, accessToken: created.accessToken })
  let offset = created.uploadOffset
  while (offset < bytes.byteLength) {
    signal.throwIfAborted()
    const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength)
    const response = await apiFetchRaw(`/api/public/slicing/jobs/${encodeURIComponent(created.job.id)}/upload`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${created.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Upload-Offset': String(offset)
      },
      body: bytes.slice(offset, end),
      signal
    })
    if (!response.ok) throw new Error(await readApiErrorMessage(response, 'The prepared project could not be uploaded.'))
    const body = await response.json() as { job: PublicSlicingJob }
    offset = body.job.uploadedBytes
    onSession?.({ job: body.job, accessToken: created.accessToken })
    onProgress(offset, bytes.byteLength)
  }
  const completed = await apiFetch<{ job: PublicSlicingJob }>(
    `/api/public/slicing/jobs/${encodeURIComponent(created.job.id)}/complete`,
    {
      method: 'POST',
      body: request,
      headers: { Authorization: `Bearer ${created.accessToken}` },
      signal
    }
  )
  const session = { job: completed.job, accessToken: created.accessToken }
  onSession?.(session)
  return session
}

export function readPublicSlice(session: PublicSlicingAccess, signal?: AbortSignal): Promise<{ job: PublicSlicingJob }> {
  return apiFetch(`/api/public/slicing/jobs/${encodeURIComponent(session.job.id)}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` },
    signal,
    timeoutMs: 15_000
  })
}

export function cancelPublicSlice(session: PublicSlicingSession): Promise<{ job: PublicSlicingJob }> {
  return apiFetch(`/api/public/slicing/jobs/${encodeURIComponent(session.job.id)}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })
}

export function retryPublicSlice(session: PublicSlicingSession): Promise<{ job: PublicSlicingJob }> {
  return apiFetch(`/api/public/slicing/jobs/${encodeURIComponent(session.job.id)}/retry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })
}

export function readPublicSliceLog(session: PublicSlicingSession): Promise<{ output: SlicingOutputLine[] }> {
  return apiFetch(`/api/public/slicing/jobs/${encodeURIComponent(session.job.id)}/log`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })
}

export async function downloadPublicSlice(session: PublicSlicingSession): Promise<Blob> {
  const response = await apiFetchRaw(`/api/public/slicing/jobs/${encodeURIComponent(session.job.id)}/download`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  })
  if (!response.ok) throw new Error(await readApiErrorMessage(response, 'The sliced file could not be downloaded.'))
  return await response.blob()
}
