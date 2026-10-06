/**
 * Archived library-version mutations.
 *
 * The parent registers this static path before current-file id routes. Prisma
 * remains workspace-scoped; byte cleanup is best-effort after the row is gone,
 * and any cleanup failure is logged without failing the completed deletion.
 */
import type { Request, Router } from 'express'
import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { LIBRARY_MANAGE_PERMISSION, type LibraryFile as LibraryFileDto } from '@printstream/shared'
import type { LibraryFile } from '@prisma/client'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { copyBridgeLibraryFile, deleteLibraryFileBytes, storeBridgeLibraryFile } from '../lib/bridge-library-files.js'
import { buildLibraryStoredPath } from '../lib/library-files.js'
import { libraryDir } from '../lib/library-paths.js'
import { resolveRequestActorAttribution } from '../lib/actor-attribution.js'
import { conflict, notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { broadcastLibraryChanged } from '../lib/ws-resource-events.js'

/** Copy a version to a new path, avoiding a round trip through the API for one-bridge copies. */
async function copyLibraryEntryBytes(
  source: { ownerBridgeId?: string | null; storedPath: string },
  target: { ownerBridgeId?: string | null; storedPath: string },
  resolveLocalPath: (row: { ownerBridgeId?: string | null; storedPath: string }) => Promise<string>
): Promise<void> {
  if (source.ownerBridgeId && target.ownerBridgeId && source.ownerBridgeId === target.ownerBridgeId) {
    await copyBridgeLibraryFile({
      ownerBridgeId: source.ownerBridgeId,
      sourceStoredPath: source.storedPath,
      targetStoredPath: target.storedPath
    })
    return
  }

  const sourcePath = await resolveLocalPath(source)
  if (target.ownerBridgeId) {
    await storeBridgeLibraryFile(target.ownerBridgeId, target.storedPath, sourcePath)
    return
  }

  await copyFile(sourcePath, path.join(libraryDir, target.storedPath))
}

/** Keep every former-current metadata field on its archived version row. */
function toLibraryFileVersionCreateInput(row: LibraryFile) {
  return {
    sourceTagSnapshotJson: row.sourceTagSnapshotJson ?? null,
    workspaceId: row.workspaceId,
    libraryFileId: row.id,
    ownerBridgeId: row.ownerBridgeId,
    folderId: row.folderId,
    name: row.name,
    storedPath: row.storedPath,
    sizeBytes: row.sizeBytes,
    kind: row.kind,
    thumbnailPath: row.thumbnailPath,
    uploadedAt: row.uploadedAt,
    versionNumber: row.currentVersionNumber,
    createdById: row.createdById ?? null,
    createdByName: row.createdByName ?? null,
    restoredFromVersionNumber: row.restoredFromVersionNumber ?? null
  }
}

/** Restore an archived version as a fresh current version while archiving the former current. */
export function registerLibraryArchivedVersionRestoreRoute(
  router: Router,
  assertDemoMutationAllowed: (request: Request, row: { hidden: boolean }) => void,
  toDto: (row: LibraryFile) => Promise<LibraryFileDto>,
  resolveLocalPath: (row: { ownerBridgeId?: string | null; storedPath: string }) => Promise<string>
): void {
  router.post('/versions/:versionId/restore', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const versionId = requireRouteParam(request.params.versionId, 'Version id')
    const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } })
    if (!version) throw notFound('Version not found')
    const current = await prisma.libraryFile.findUnique({ where: { id: version.libraryFileId } })
    if (!current?.ownerBridgeId) throw notFound('File not found')
    assertDemoMutationAllowed(request, current)

    const storedPath = buildLibraryStoredPath(current.name)
    await copyLibraryEntryBytes(version, {
      ownerBridgeId: current.ownerBridgeId,
      storedPath
    }, resolveLocalPath)

    const attribution = await resolveRequestActorAttribution(request)
    let restored
    try {
      restored = await prisma.$transaction(async (tx) => {
        await tx.libraryFileVersion.create({
          data: toLibraryFileVersionCreateInput(current)
        })
        return await tx.libraryFile.update({
          where: { id: current.id },
          data: {
            storedPath,
            sourceTagSnapshotJson: version.sourceTagSnapshotJson ?? null,
            sizeBytes: version.sizeBytes,
            kind: version.kind,
            thumbnailPath: version.thumbnailPath,
            uploadedAt: new Date(),
            currentVersionNumber: current.currentVersionNumber + 1,
            snapshotKey: null,
            // The new current content is a copy of an archived version, attributed to the actor.
            restoredFromVersionNumber: version.versionNumber,
            createdById: attribution.createdById,
            createdByName: attribution.createdByName
          }
        })
      })
    } catch (error) {
      await deleteLibraryFileBytes({ ownerBridgeId: current.ownerBridgeId, storedPath }).catch((cleanupError) => {
        // Preserve the transaction failure while leaving a trace of any orphaned copied bytes.
        console.warn(`[library] failed to clean up restored bytes for ${current.id}: ${(cleanupError as Error).message}`)
      })
      throw error
    }

    annotateRequestAuditLog(request, {
      action: 'restore-version',
      resource: 'library file',
      summary: `Restored library file ${current.name} from version ${version.versionNumber}.`,
      metadata: {
        fileId: current.id,
        fileName: current.name,
        versionId: version.id,
        restoredVersionNumber: version.versionNumber
      }
    })
    broadcastLibraryChanged()
    response.json({ file: await toDto(restored) })
  })
}

/** Register archived-version deletion using the parent's demo mutation policy. */
export function registerLibraryArchivedVersionDeleteRoute(
  router: Router,
  assertDemoMutationAllowed: (request: Request, row: { hidden: boolean }) => void
): void {
  router.delete('/versions/:versionId', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const versionId = requireRouteParam(request.params.versionId, 'Version id')
    const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } })
    if (!version) throw notFound('Version not found')
    const current = await prisma.libraryFile.findUnique({ where: { id: version.libraryFileId } })
    if (!current) throw notFound('File not found')
    assertDemoMutationAllowed(request, current)

    await prisma.libraryFileVersion.delete({ where: { id: version.id } })

    // Each archived version keeps its own copy of the bytes, but guard against deleting bytes
    // still referenced by the current file or another version before removing them from storage.
    if (version.ownerBridgeId) {
      const sharedByCurrent = current.storedPath === version.storedPath && (current.ownerBridgeId ?? null) === version.ownerBridgeId
      const sharedByOtherVersion = await prisma.libraryFileVersion.count({
        where: { ownerBridgeId: version.ownerBridgeId, storedPath: version.storedPath }
      })
      if (!sharedByCurrent && sharedByOtherVersion === 0) {
        // The version row is already gone; a byte-cleanup failure only leaks storage, so don't fail
        // the request, but log it so the orphan is traceable.
        await deleteLibraryFileBytes({ ownerBridgeId: version.ownerBridgeId, storedPath: version.storedPath })
          .catch((error) => console.warn(`[library] failed to delete bytes for removed version ${version.id}: ${(error as Error).message}`))
      }
    }

    annotateRequestAuditLog(request, {
      action: 'delete-version',
      resource: 'library file',
      summary: `Deleted version ${version.versionNumber} of ${current.name}.`,
      metadata: { fileId: current.id, fileName: current.name, versionId: version.id, versionNumber: version.versionNumber }
    })
    broadcastLibraryChanged()
    response.status(204).end()
  })
}

/**
 * Delete the current version by promoting the most recent archive, preserving its original
 * version number and bytes. A file with no archive must retain its only current version.
 */
export function registerLibraryCurrentVersionDeleteRoute(
  router: Router,
  assertDemoMutationAllowed: (request: Request, row: { hidden: boolean }) => void,
  toDto: (row: LibraryFile) => Promise<LibraryFileDto>
): void {
  router.delete('/:id/current-version', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const current = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!current) throw notFound('File not found')
    assertDemoMutationAllowed(request, current)

    const prev = await prisma.libraryFileVersion.findFirst({
      where: { libraryFileId: current.id },
      orderBy: { versionNumber: 'desc' }
    })
    if (!prev) throw conflict('Cannot delete the only version of a file.')

    const oldStoredPath = current.storedPath
    const oldOwnerBridgeId = current.ownerBridgeId ?? null

    const updated = await prisma.$transaction(async (tx) => {
      const file = await tx.libraryFile.update({
        where: { id: current.id },
        data: {
          // The previous version's bytes become the current content verbatim: the file
          // now *is* that version (number and all), not a new "restored from" copy.
          sourceTagSnapshotJson: prev.sourceTagSnapshotJson ?? null,
          storedPath: prev.storedPath,
          ownerBridgeId: prev.ownerBridgeId,
          sizeBytes: prev.sizeBytes,
          kind: prev.kind,
          thumbnailPath: prev.thumbnailPath,
          uploadedAt: prev.uploadedAt,
          currentVersionNumber: prev.versionNumber,
          snapshotKey: null,
          restoredFromVersionNumber: prev.restoredFromVersionNumber ?? null,
          createdById: prev.createdById ?? null,
          createdByName: prev.createdByName ?? null
        }
      })
      await tx.libraryFileVersion.delete({ where: { id: prev.id } })
      return file
    })

    // The old current's bytes are now unreferenced (the file points at the previous
    // version's path). Drop them unless still shared by the new current or another version.
    if (oldOwnerBridgeId) {
      const sharedByCurrent = updated.storedPath === oldStoredPath && (updated.ownerBridgeId ?? null) === oldOwnerBridgeId
      const sharedByVersion = await prisma.libraryFileVersion.count({
        where: { ownerBridgeId: oldOwnerBridgeId, storedPath: oldStoredPath }
      })
      if (!sharedByCurrent && sharedByVersion === 0) {
        await deleteLibraryFileBytes({ ownerBridgeId: oldOwnerBridgeId, storedPath: oldStoredPath })
          .catch((error) => console.warn(`[library] failed to delete bytes for deleted current version of ${current.id}: ${(error as Error).message}`))
      }
    }

    annotateRequestAuditLog(request, {
      action: 'delete-current-version',
      resource: 'library file',
      summary: `Deleted current version ${current.currentVersionNumber} of ${current.name}; reverted to version ${prev.versionNumber}.`,
      metadata: { fileId: current.id, fileName: current.name, deletedVersionNumber: current.currentVersionNumber, revertedToVersionNumber: prev.versionNumber }
    })
    broadcastLibraryChanged()
    response.json({ file: await toDto(updated) })
  })
}
