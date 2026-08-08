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
 * `snapshotKey`), which is what makes the retention promise durable — and what
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
import { prisma } from './prisma.js'
import { getCurrentWorkspace } from './workspace-context.js'

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

  const ownerBridgeId = requireOwnerBridgeId(file.ownerBridgeId)
  const sourceInfo = await statBridgeLibraryFile({ ownerBridgeId, storedPath: file.storedPath })
  const contentHash = sourceInfo.contentSha256
  const snapshotKey = buildSnapshotKey(file.name, contentHash)
  const storedPath = buildSnapshotStoredPath(file.name, contentHash)

  const existing = await prisma.libraryFile.findUnique({ where: { snapshotKey }, select: SNAPSHOT_SELECT })
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
  const workspaceId = requireWorkspaceId()

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
    const raced = await prisma.libraryFile.findUnique({ where: { snapshotKey }, select: SNAPSHOT_SELECT })
    if (raced) return raced
    throw error
  }
}

/**
 * Store a file that exists only on local disk as a hidden, content-deduped snapshot.
 *
 * The counterpart of {@link ensureLibrarySnapshotRecord} for bytes that were never a
 * library file — today the prepared project 3MF the slicer was handed, which lives in
 * a temp dir that is deleted the moment the slice returns. Hashing happens locally
 * (the bytes are already here) rather than by round-tripping through the bridge.
 *
 * Idempotent: identical bytes under the same name resolve to the existing row without
 * re-uploading. Never overwrites or versions anything — a snapshot row is immutable.
 */
export async function ensureLibrarySnapshotFromLocalPath(input: {
  workspaceId: string
  ownerBridgeId: string
  fileName: string
  sourcePath: string
  sizeBytes: number
}): Promise<SnapshotLibraryFile> {
  const contentHash = await hashLocalFile(input.sourcePath)
  const snapshotKey = buildSnapshotKey(input.fileName, contentHash)

  const existing = await prisma.libraryFile.findUnique({
    where: { snapshotKey },
    select: SNAPSHOT_SELECT
  })
  if (existing) return existing

  const storedPath = buildSnapshotStoredPath(input.fileName, contentHash)
  await storeBridgeLibraryFile(input.ownerBridgeId, storedPath, input.sourcePath)

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
    const raced = await prisma.libraryFile.findUnique({ where: { snapshotKey }, select: SNAPSHOT_SELECT })
    if (raced) return raced
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

