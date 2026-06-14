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

/** Build the credentialed binary-mesh URL for a staged import (rendered by `STLLoader.parse`). */
export function importMeshUrl(importId: string): string {
  return buildApiUrl(`/api/editor/imports/${encodeURIComponent(importId)}/mesh`)
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

/** Fetch a staged import's binary STL mesh with credentials (for `STLLoader.parse`). */
export async function fetchImportMesh(importId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(importMeshUrl(importId), {
    method: 'GET',
    credentials: 'include',
    headers: tenantHeaders(),
    signal
  })
  if (!response.ok) {
    throw new Error(`Unable to load imported model mesh (${response.status}).`)
  }
  return response.arrayBuffer()
}
