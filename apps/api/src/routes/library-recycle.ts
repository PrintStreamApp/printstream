/**
 * Recycle-bin routes for workspace library files.
 *
 * Soft-deleted files retain their bytes and version history until restore, explicit deletion, or
 * retention cleanup. `library.ts` registers this family before file-id routes and supplies the
 * shared DTO and demo mutation policies so those rules cannot drift between surfaces.
 */
import type { LibraryFile as LibraryFileModel } from '@prisma/client'
import type { Request, Router } from 'express'
import { z } from 'zod'
import {
  deleteOperationResponseSchema,
  LIBRARY_MANAGE_PERMISSION,
  libraryRecycleBinResponseSchema,
  type LibraryFile
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requireRequestWorkspaceId } from '../lib/request-helpers.js'
import { broadcastLibraryChanged } from '../lib/ws-resource-events.js'

// ---- Recycle bin ------------------------------------------------------------
// Soft-deleted files keep their bytes + version history and stay restorable
// until restored, individually hard-deleted, or aged out by the cleanup task
// (LIBRARY_RECYCLE_RETENTION_DAYS). These routes must register before the
// `/:id` param routes so `/recycle-bin` is not swallowed as a file id.

const recycleFilesSchema = z.object({ fileIds: z.array(z.string().min(1)).min(1).max(500) })

/** Register the recycle-bin routes before parameterized file-id routes. */
export function registerLibraryRecycleRoutes(
  router: Router,
  policies: {
    toDto: (row: LibraryFileModel) => Promise<LibraryFile>
    assertDemoLibraryFileMutationAllowed: (request: Request, row: { hidden: boolean }) => void
  }
): void {
  const { toDto, assertDemoLibraryFileMutationAllowed } = policies
  /** List the recycle bin, newest deletions first. */
  router.get('/recycle-bin', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const workspaceId = request.workspace?.id ?? null
    const rows = await prisma.libraryFile.findMany({
      where: { deletedAt: { not: null }, hidden: false, ...(workspaceId ? { workspaceId } : {}) },
      orderBy: { deletedAt: 'desc' }
    }) as Array<LibraryFileModel & { deletedAt: Date }>
    response.json(libraryRecycleBinResponseSchema.parse({
      files: await Promise.all(rows.map(async (row) => ({
        ...(await toDto(row)),
        deletedAt: row.deletedAt.toISOString()
      })))
    }))
  })

  /** Move files to the recycle bin (soft delete). */
  router.post('/recycle-bin/files', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const parsed = recycleFilesSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid recycle payload')
    const workspaceId = requireRequestWorkspaceId(request)
    const rows = await prisma.libraryFile.findMany({
      where: { id: { in: parsed.data.fileIds }, workspaceId },
      select: { id: true, name: true, hidden: true, deletedAt: true }
    })
    if (rows.length !== parsed.data.fileIds.length) throw notFound('One or more files were not found')
    for (const row of rows) assertDemoLibraryFileMutationAllowed(request, row)
    const targetIds = rows.filter((row) => !row.hidden && !row.deletedAt).map((row) => row.id)
    if (targetIds.length > 0) {
      await prisma.libraryFile.updateMany({ where: { id: { in: targetIds } }, data: { deletedAt: new Date() } })
    }
    annotateRequestAuditLog(request, {
      action: 'recycle',
      resource: 'library file',
      summary: targetIds.length === 1
        ? `Moved library file ${rows[0]?.name ?? ''} to the recycle bin.`
        : `Moved ${targetIds.length} library files to the recycle bin.`,
      metadata: { fileIds: targetIds }
    })
    broadcastLibraryChanged()
    response.json({ recycled: targetIds.length })
  })

  /** Restore recycled files back into the library (their folder if it still exists, else the root). */
  router.post('/recycle-bin/restore', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const parsed = recycleFilesSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid restore payload')
    const workspaceId = requireRequestWorkspaceId(request)
    const rows = await prisma.libraryFile.findMany({
      where: { id: { in: parsed.data.fileIds }, workspaceId, deletedAt: { not: null } },
      select: { id: true, name: true }
    })
    if (rows.length === 0) throw notFound('No recycled files to restore')
    await prisma.libraryFile.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: { deletedAt: null }
    })
    annotateRequestAuditLog(request, {
      action: 'restore',
      resource: 'library file',
      summary: rows.length === 1
        ? `Restored library file ${rows[0]?.name ?? ''} from the recycle bin.`
        : `Restored ${rows.length} library files from the recycle bin.`,
      metadata: { fileIds: rows.map((row) => row.id) }
    })
    broadcastLibraryChanged()
    response.json({ restored: rows.length })
  })

  /** Permanently delete everything in the recycle bin via a queued delete job. */
  router.delete('/recycle-bin', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const rows = await prisma.libraryFile.findMany({
      where: { workspaceId, deletedAt: { not: null } },
      select: { id: true, name: true, hidden: true }
    })
    if (rows.length === 0) throw conflict('The recycle bin is already empty')
    for (const row of rows) assertDemoLibraryFileMutationAllowed(request, row)
    const job = await deleteOperationDispatcher.enqueueLibraryDelete(rows.map((row) => row.id))
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: 'library file',
      summary: `Emptied the recycle bin (${rows.length} file${rows.length === 1 ? '' : 's'}).`,
      metadata: { deleteOperationId: job.id, fileIds: rows.map((row) => row.id), itemCount: rows.length }
    })
    response.status(202).json(deleteOperationResponseSchema.parse({ job }))
  })
}
