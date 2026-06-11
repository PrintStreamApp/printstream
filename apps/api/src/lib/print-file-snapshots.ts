/**
 * Deduplicated hidden library snapshots for dispatched print files.
 *
 * Print history should remain re-printable even if the user later removes or
 * replaces the visible library entry. We persist one hidden snapshot per file
 * version/name and reuse it across repeated prints and reprints.
 */
import path from 'node:path'
import {
  copyBridgeLibraryFile,
  ensureBridgeLibraryLocalCopy,
  statBridgeLibraryFile,
  storeBridgeLibraryFile
} from './bridge-library-files.js'
import { prisma } from './prisma.js'
import { getCurrentTenant } from './tenant-context.js'

export interface SnapshotLibraryFile {
  id: string
  tenantId: string
  name: string
  ownerBridgeId?: string | null
  storedPath: string
  sizeBytes: number
  kind: string
  snapshotKey: string | null
}

export async function ensureLibraryFileSnapshot(fileId: string): Promise<SnapshotLibraryFile> {
  const file = await prisma.libraryFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      tenantId: true,
      name: true,
      ownerBridgeId: true,
      storedPath: true,
      sizeBytes: true,
      kind: true,
      snapshotKey: true
    }
  })
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

  const existing = await prisma.libraryFile.findUnique({
    where: { snapshotKey },
    select: {
      id: true,
      tenantId: true,
      name: true,
      ownerBridgeId: true,
      storedPath: true,
      sizeBytes: true,
      kind: true,
      snapshotKey: true
    }
  })
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
  const tenantId = requireTenantId()

  try {
    return await prisma.libraryFile.create({
      data: {
        tenantId,
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
      select: {
        id: true,
        tenantId: true,
        name: true,
        storedPath: true,
        sizeBytes: true,
        kind: true,
        ownerBridgeId: true,
        snapshotKey: true
      }
    })
  } catch (error) {
    const raced = await prisma.libraryFile.findUnique({
      where: { snapshotKey },
      select: {
        id: true,
        tenantId: true,
        name: true,
        ownerBridgeId: true,
        storedPath: true,
        sizeBytes: true,
        kind: true,
        snapshotKey: true
      }
    })
    if (raced) return raced
    throw error
  }
}

function requireTenantId(): string {
  const tenantId = getCurrentTenant()?.id
  if (tenantId) {
    return tenantId
  }

  throw new Error('Tenant context is required for print file snapshots.')
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

