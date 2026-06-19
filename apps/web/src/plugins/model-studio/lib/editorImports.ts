/**
 * Client helpers for the editor's foreign-model staging endpoints.
 *
 * Imports are staged server-side: a foreign STL/STEP/3MF is parsed (and STEP
 * tessellated) into a mesh keyed by `importId`. An import-backed editor instance
 * then references that `importId` in the `SceneEdit` it emits; the backend bakes
 * the staged mesh into the output 3MF at save/slice time, so no extra upload is
 * needed later.
 *
 * `apiFetch` is JSON-only, so the multipart upload here uses a raw `fetch` that
 * mirrors `apiFetch`'s credentials + workspace-context header handling. The mesh
 * itself is fetched as a binary STL (rendered with `STLLoader.parse`) rather than
 * shipped as JSON.
 */
import { extractErrorMessage, type StagedImport } from '@printstream/shared'
import { buildApiUrl } from '../../../lib/apiUrl'
import { readWorkspaceContextHeader } from '../../../lib/workspaceContext'
import { fetchModelBytes } from './modelFetch'

/**
 * Build the credentialed binary-mesh URL for a staged import (rendered by `STLLoader.parse`).
 * Pass `partIndex` to fetch one solid of a multi-solid import; omit it for the merged mesh.
 */
export function importMeshUrl(importId: string, partIndex?: number): string {
  const base = buildApiUrl(`/api/editor/imports/${encodeURIComponent(importId)}/mesh`)
  if (partIndex == null) return base
  // buildApiUrl may already have added a query (e.g. ?tenant=…), so use the right separator —
  // a second `?` makes the server read `part` as part of the tenant value, so every solid would
  // wrongly fetch the full merged mesh (7× the bytes → the "model download stalled" the user hit).
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}part=${encodeURIComponent(String(partIndex))}`
}

function tenantHeaders(): Record<string, string> {
  const workspaceContext = readWorkspaceContextHeader()
  return workspaceContext ? { 'X-PrintStream-Tenant': workspaceContext } : {}
}

async function readImportResponse(response: Response): Promise<StagedImport> {
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text()
  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, `Import failed (${response.status})`))
  }
  return (payload as { import: StagedImport }).import
}

/** Stage a foreign model from the user's filesystem (multipart, field `file`). */
export async function stageImportFromFile(file: File, signal?: AbortSignal): Promise<StagedImport> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(buildApiUrl('/api/editor/imports'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', ...tenantHeaders() },
    body: form,
    signal
  })
  return readImportResponse(response)
}

/** Stage a foreign model from an existing library file (optionally a single object). */
export async function stageImportFromLibrary(
  libraryFileId: string,
  objectId: number | undefined,
  signal?: AbortSignal
): Promise<StagedImport> {
  const response = await fetch(buildApiUrl('/api/editor/imports/from-library'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...tenantHeaders() },
    body: JSON.stringify(objectId == null ? { libraryFileId } : { libraryFileId, objectId }),
    signal
  })
  return readImportResponse(response)
}

/**
 * Fetch a staged import's binary STL mesh with credentials (for `STLLoader.parse`). Pass
 * `partIndex` for one solid of a multi-solid import; omit it for the merged mesh.
 */
export async function fetchImportMesh(importId: string, partIndex?: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  // Stall-guarded so a transport that hangs mid-body surfaces an error instead of freezing
  // the editor's geometry build (see `modelFetch`).
  const bytes = await fetchModelBytes(importMeshUrl(importId, partIndex), {
    method: 'GET',
    credentials: 'include',
    headers: tenantHeaders(),
    signal
  })
  // `fetchModelBytes` returns a tightly-sized Uint8Array backed by a fresh ArrayBuffer.
  return bytes.buffer as ArrayBuffer
}
