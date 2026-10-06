/**
 * Durable state for resumable library uploads.
 *
 * Session metadata is replaced atomically so status polls never read partial JSON. The per-id
 * mutex serializes chunk appends, completion, cancellation, and expiry cleanup; completed state
 * remains for a bounded retry window, while Prisma receipts own long-lived reconciliation.
 */
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryFile } from '@printstream/shared'
import { createKeyedMutex } from './keyed-mutex.js'
import { libraryDir } from './library-paths.js'

// Created synchronously at module load so the CommonJS SEA bundle needs no top-level await.
const libraryUploadSessionDir = path.join(libraryDir, '.uploads')
mkdirSync(libraryUploadSessionDir, { recursive: true })

/** Completed upload results remain queryable long enough for timed-out clients to reconcile. */
export const LIBRARY_UPLOAD_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000

export interface LibraryUploadSession {
  id: string
  fileName: string
  sizeBytes: number
  receivedBytes: number
  phase: 'receiving' | 'transferring' | 'finalizing' | 'completed'
  bridgeReceivedBytes: number
  workspaceId: string
  folderId: string | null
  bridgeId: string | null
  hidden: boolean
  /** Folder chain below `folderId` to create/resolve at completion (folder-structure uploads). */
  relativeFolderPath?: string[] | null
  createdAt: string
  /** Digest of the completion intent, fixed once irreversible work begins. */
  completionDigest?: string | null
  /** Authoritative response retained for idempotent retries and status reconciliation. */
  completion?: LibraryUploadCompletion | null
  completedAt?: string | null
}

export interface LibraryUploadCompletion {
  statusCode: 201
  body: {
    file: LibraryFile | { id: string; name: string }
    unchanged?: boolean
    archivedVersionId?: string | null
    snapshot?: true
    preparedSourceId?: string | null
  }
}

export type LibraryUploadSessionResponse = Pick<LibraryUploadSession,
  'id' | 'fileName' | 'sizeBytes' | 'receivedBytes' | 'phase' | 'bridgeReceivedBytes'
> & { completion: LibraryUploadCompletion | null }

export function sessionPaths(uploadId: string): { dataPath: string; metaPath: string } {
  const safeId = uploadId.replace(/[^a-zA-Z0-9-]/g, '')
  return {
    dataPath: path.join(libraryUploadSessionDir, `${safeId}.part`),
    metaPath: path.join(libraryUploadSessionDir, `${safeId}.json`)
  }
}

// Serialize chunk appends per upload session: two in-flight chunks for one
// uploadId must not both read the same receivedBytes, pass the offset check, and
// interleave their bytes into the staged file (which would silently corrupt it).
export const uploadChunkMutex = createKeyedMutex()

export async function readUploadSession(uploadId: string): Promise<LibraryUploadSession | null> {
  try {
    const { metaPath } = sessionPaths(uploadId)
    return JSON.parse(await readFile(metaPath, 'utf8')) as LibraryUploadSession
  } catch {
    return null
  }
}

export async function writeUploadSession(session: LibraryUploadSession): Promise<void> {
  const { metaPath } = sessionPaths(session.id)
  const pendingPath = `${metaPath}.${randomUUID()}.tmp`
  try {
    // Status polling runs concurrently with uploads. Replace a complete sibling file atomically so
    // readers see either the previous state or the next one, never half of a JSON serialization.
    await writeFile(pendingPath, JSON.stringify(session), 'utf8')
    await rename(pendingPath, metaPath)
  } finally {
    await rm(pendingPath, { force: true }).catch(() => undefined)
  }
}

export async function deleteUploadSession(uploadId: string): Promise<void> {
  const { dataPath, metaPath } = sessionPaths(uploadId)
  await Promise.all([
    rm(dataPath, { force: true }).catch(() => undefined),
    rm(metaPath, { force: true }).catch(() => undefined)
  ])
}

/** Remove reconciled upload sessions after their bounded recovery window. */
export async function pruneExpiredUploadSessions(now = Date.now()): Promise<void> {
  let names: string[]
  try {
    names = await readdir(libraryUploadSessionDir)
  } catch (error) {
    if (isFileNotFoundError(error)) return
    console.warn('[library] could not scan completed upload sessions for cleanup', error instanceof Error ? error.message : error)
    return
  }
  await Promise.all(names
    .filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
    .map(async (name) => {
      const uploadId = name.slice(0, -'.json'.length)
      const session = await readUploadSession(uploadId)
      const timestamp = Date.parse(session?.completedAt ?? '')
      if (session?.phase !== 'completed') return
      if (!Number.isFinite(timestamp) || now - timestamp < LIBRARY_UPLOAD_SESSION_RETENTION_MS) return
      await uploadChunkMutex.run(uploadId, async () => {
        // The first read is only a cheap candidate scan. Re-check under the same lock as chunks and
        // completion so recovery cleanup cannot delete a session that resumed in the meantime.
        const current = await readUploadSession(uploadId)
        const completedAt = Date.parse(current?.completedAt ?? '')
        if (current?.phase !== 'completed'
          || !Number.isFinite(completedAt)
          || now - completedAt < LIBRARY_UPLOAD_SESSION_RETENTION_MS) return
        await deleteUploadSession(uploadId)
      })
    }))
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'ENOENT'
}

export function toUploadSessionResponse(session: LibraryUploadSession): LibraryUploadSessionResponse {
  return {
    id: session.id,
    fileName: session.fileName,
    sizeBytes: session.sizeBytes,
    receivedBytes: session.receivedBytes,
    phase: session.phase,
    bridgeReceivedBytes: session.bridgeReceivedBytes,
    completion: session.completion ?? null
  }
}
