/**
 * Deduplicated hidden library snapshots for dispatched print files and for the
 * project 3MFs they were sliced from.
 *
 * Print history should remain re-printable even if the user later removes or
 * replaces the visible library entry. We persist one hidden snapshot per file
 * version/name and reuse it across repeated prints and reprints.
 *
 * Snapshots are content-addressed: the key is `sha256:basename`, so slicing or
 * printing the same bytes repeatedly stores exactly one copy. They are the one
 * hidden variant `library-cleanup.ts` never sweeps (it skips rows with a
 * `snapshotKey`), which is what makes the retention promise durable, and what
 * makes writing one a deliberate act rather than a cache fill.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { classifyLibraryFileKind } from '@printstream/shared'
import {
  copyBridgeLibraryFile,
  ensureBridgeLibraryLocalCopy,
  statBridgeLibraryFile,
  storeBridgeLibraryFile
} from './bridge-library-files.js'
import { prisma, rootPrisma } from './prisma.js'
import { getCurrentWorkspace } from './workspace-context.js'
import { createKeyedMutex } from './keyed-mutex.js'

/** Serializes row and byte mutations for one workspace-local content-addressed snapshot. */
export const snapshotMutationMutex = createKeyedMutex()
export function snapshotMutationKey(workspaceId: string, snapshotKey: string): string {
  return `${workspaceId}:${snapshotKey}`
}

export interface SnapshotLibraryFile {
  id: string
  workspaceId: string
  name: string
  ownerBridgeId?: string | null
  storedPath: string
  sizeBytes: number
  kind: string
  snapshotKey: string | null
}

/** The columns {@link SnapshotLibraryFile} is made of; every lookup here selects exactly these. */
const SNAPSHOT_SELECT = {
  id: true,
  workspaceId: true,
  name: true,
  ownerBridgeId: true,
  storedPath: true,
  sizeBytes: true,
  kind: true,
  snapshotKey: true
} as const

export async function ensureLibraryFileSnapshot(fileId: string): Promise<SnapshotLibraryFile> {
  const file = await prisma.libraryFile.findUnique({ where: { id: fileId }, select: SNAPSHOT_SELECT })
  if (!file) throw new Error('File not found')
  return ensureLibrarySnapshotRecord(file)
}

export async function ensureLibrarySnapshotRecord(file: SnapshotLibraryFile): Promise<SnapshotLibraryFile> {
  if (file.snapshotKey) return file

  const workspaceId = requireWorkspaceId()
  const ownerBridgeId = requireOwnerBridgeId(file.ownerBridgeId)
  const sourceInfo = await statBridgeLibraryFile({ ownerBridgeId, storedPath: file.storedPath })
  const contentHash = sourceInfo.contentSha256
  const snapshotKey = buildSnapshotKey(file.name, contentHash)
  const storedPath = buildSnapshotStoredPath(file.name, contentHash)

  return snapshotMutationMutex.run(snapshotMutationKey(workspaceId, snapshotKey), async () => {
    const existing = await refreshSnapshotIfExists(workspaceId, snapshotKey)
    if (existing) {
      await ensureSnapshotStored({
        sourceBridgeId: ownerBridgeId,
        sourceStoredPath: file.storedPath,
        targetBridgeId: requireOwnerBridgeId(existing.ownerBridgeId),
        targetStoredPath: existing.storedPath
      })
      return existing
    }

    await ensureSnapshotStored({
      sourceBridgeId: ownerBridgeId,
      sourceStoredPath: file.storedPath,
      targetBridgeId: ownerBridgeId,
      targetStoredPath: storedPath
    })
    try {
      return await prisma.libraryFile.create({
        data: {
          workspaceId,
          ownerBridgeId,
          name: file.name,
          storedPath,
          sizeBytes: sourceInfo.sizeBytes,
          kind: file.kind,
          hidden: true,
          snapshotKey,
          origin: 'snapshot',
          folderId: null
        },
        select: SNAPSHOT_SELECT
      })
    } catch (error) {
      const raced = await refreshSnapshotIfExists(workspaceId, snapshotKey)
      if (raced) return raced
      throw error
    }
  })
}

/**
 * Store a file that exists only on local disk as a hidden, content-deduped snapshot.
 *
 * The counterpart of {@link ensureLibrarySnapshotRecord} for bytes that were never a
 * library file: the prepared project 3MF the slicer was handed, which lives in a temp
 * dir that is deleted the moment the slice returns, and the browser-baked project an
 * editor session stages (`POST /api/library/uploads/:id/complete` with `snapshot`) to
 * slice work the user has not saved. Hashing happens locally (the bytes are already
 * here) rather than by round-tripping through the bridge.
 *
 * Idempotent: identical bytes under the same name resolve to the existing row without
 * re-uploading. Never overwrites or versions anything, a snapshot row is immutable.
 */
export async function ensureLibrarySnapshotFromLocalPath(input: {
  workspaceId: string
  ownerBridgeId: string
  fileName: string
  sourcePath: string
  sizeBytes: number
  /**
   * Bytes handed to the bridge so far. Never called on a dedupe hit, which transfers nothing:
   * a caller reporting progress must treat "no callback at all" as done, not as stalled.
   */
  onBridgeProgress?: (transferredBytes: number) => Promise<void> | void
}): Promise<SnapshotLibraryFile> {
  const contentHash = await hashLocalFile(input.sourcePath)
  const snapshotKey = buildSnapshotKey(input.fileName, contentHash)

  return snapshotMutationMutex.run(snapshotMutationKey(input.workspaceId, snapshotKey), async () => {
    const existing = await refreshSnapshotIfExists(input.workspaceId, snapshotKey)
    if (existing) {
      return existing
    }

    const storedPath = buildSnapshotStoredPath(input.fileName, contentHash)
    await storeBridgeLibraryFile(input.ownerBridgeId, storedPath, input.sourcePath, { onProgress: input.onBridgeProgress })

    try {
      return await prisma.libraryFile.create({
        data: {
          workspaceId: input.workspaceId,
          ownerBridgeId: input.ownerBridgeId,
          name: path.basename(input.fileName),
          storedPath,
          sizeBytes: input.sizeBytes,
          kind: classifyLibraryFileKind(input.fileName),
          hidden: true,
          snapshotKey,
          origin: 'snapshot',
          folderId: null
        },
        select: SNAPSHOT_SELECT
      })
    } catch (error) {
      const raced = await refreshSnapshotIfExists(input.workspaceId, snapshotKey)
      if (raced) return raced
      throw error
    }
  })
}

/** Atomically find and refresh a workspace-local dedupe hit, or return null when none exists. */
async function refreshSnapshotIfExists(workspaceId: string, snapshotKey: string): Promise<SnapshotLibraryFile | null> {
  try {
    // The scoped client's ownership pre-read intentionally turns an update miss into an
    // HTTP 404. This compound selector already contains the workspace identity, so use the
    // base client to preserve Prisma's P2025 dedupe-miss signal without weakening isolation.
    return await rootPrisma.libraryFile.update({
      where: { workspaceId_snapshotKey: { workspaceId, snapshotKey } },
      data: { uploadedAt: new Date() },
      select: SNAPSHOT_SELECT
    })
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'P2025') return null
    throw error
  }
}

async function hashLocalFile(sourcePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(sourcePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function requireWorkspaceId(): string {
  const workspaceId = getCurrentWorkspace()?.id
  if (workspaceId) {
    return workspaceId
  }

  throw new Error('Workspace context is required for print file snapshots.')
}

function requireOwnerBridgeId(ownerBridgeId: string | null | undefined): string {
  if (!ownerBridgeId) {
    throw new Error('Bridge-backed library file required for print snapshots')
  }
  return ownerBridgeId
}

async function ensureSnapshotStored(input: {
  sourceBridgeId: string
  sourceStoredPath: string
  targetBridgeId: string
  targetStoredPath: string
}): Promise<void> {
  if (input.sourceBridgeId === input.targetBridgeId) {
    await copyBridgeLibraryFile({
      ownerBridgeId: input.sourceBridgeId,
      sourceStoredPath: input.sourceStoredPath,
      targetStoredPath: input.targetStoredPath
    })
    return
  }

  const sourcePath = await ensureBridgeLibraryLocalCopy({
    bridgeId: input.sourceBridgeId,
    storedPath: input.sourceStoredPath
  })
  await storeBridgeLibraryFile(input.targetBridgeId, input.targetStoredPath, sourcePath)
}

function buildSnapshotKey(fileName: string, contentHash: string): string {
  return `${contentHash}:${path.basename(fileName)}`
}

function buildSnapshotStoredPath(fileName: string, contentHash: string): string {
  const base = path.basename(fileName)
  const safeBase = base.replace(/[^\w.-]+/g, '_')
  return `${contentHash.slice(0, 16)}-${safeBase}`
}
