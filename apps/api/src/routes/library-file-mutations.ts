/**
 * Current library-file mutations.
 *
 * The parent registers delete, queued delete, rename/move, and personal favorite actions at
 * their existing late file-id seam. Prisma enforces workspace scope; bytes are bridge-owned and
 * cleanup failures after a committed delete are logged without changing the successful response.
 */
import type { LibraryFile } from '@prisma/client'
import type { Request, Router } from 'express'
import { z } from 'zod'
import {
  deleteOperationResponseSchema,
  LIBRARY_MANAGE_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  startLibraryDeleteJobSchema,
  type LibraryFile as LibraryFileDto
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { deleteLibraryFileBytes } from '../lib/bridge-library-files.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { resolveFavoriteOwnerKey } from '../lib/library-favorites.js'
import { visibleLibraryFilesWhere } from '../lib/library-visibility.js'
import { prisma } from '../lib/prisma.js'
import { isUniqueConstraintError } from '../lib/prisma-errors.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastLibraryChanged } from '../lib/ws-resource-events.js'

/** Register file mutation routes using the parent's DTO and demo-mode policies. */
export function registerLibraryFileMutationRoutes(
  router: Router,
  dependencies: {
    toDto: (row: LibraryFile, options?: { cacheOnly?: boolean; favorite?: boolean }) => Promise<LibraryFileDto>
    assertDemoMutationAllowed: (request: Request, row: { hidden: boolean }) => void
  }
): void {
  const { toDto, assertDemoMutationAllowed } = dependencies
  router.delete('/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({
      where: { id: fileId },
      include: {
        versions: {
          select: {
            ownerBridgeId: true,
            storedPath: true
          }
        }
      }
    })
    if (!row?.ownerBridgeId) throw notFound('File not found')
    assertDemoMutationAllowed(request, row)
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: 'library file',
      summary: `Deleted library file ${row.name}.`,
      metadata: {
        fileId: row.id,
        fileName: row.name
      }
    })
    await prisma.libraryFile.delete({ where: { id: row.id } })
    await deleteLibraryFileBytes(row).catch((error) => {
      console.warn(`[library] failed to delete current bytes for removed file ${row.id}: ${(error as Error).message}`)
    })
    await Promise.all(row.versions.map(async (version) => {
      await deleteLibraryFileBytes(version).catch((error) => {
        console.warn(`[library] failed to delete archived bytes for removed file ${row.id}: ${(error as Error).message}`)
      })
    }))
    if (!row.hidden) broadcastLibraryChanged()
    response.status(204).end()
  })

  router.post('/delete-jobs', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const parsed = startLibraryDeleteJobSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid delete payload')
    const rows = await prisma.libraryFile.findMany({
      where: { id: { in: parsed.data.fileIds } },
      select: { hidden: true }
    })
    for (const row of rows) {
      assertDemoMutationAllowed(request, row)
    }
    const job = await deleteOperationDispatcher.enqueueLibraryDelete(parsed.data.fileIds)
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: 'library file',
      summary: job.totalItems === 1
        ? `Queued delete of library file ${job.summaryLabel}.`
        : `Queued delete of ${job.totalItems} library files.`,
      metadata: {
        deleteOperationId: job.id,
        fileIds: parsed.data.fileIds,
        itemCount: job.totalItems,
        summaryLabel: job.summaryLabel
      }
    })
    response.status(202).json(deleteOperationResponseSchema.parse({ job }))
  })

  const updateFileSchema = z
    .object({
      bridgeId: z.string().trim().min(1).nullable().optional(),
      name: z.string().trim().min(1).max(255).optional(),
      folderId: z.string().nullable().optional()
    })
    .refine((data) => data.name !== undefined || data.folderId !== undefined || data.bridgeId !== undefined, {
      message: 'Provide name, folderId, or bridgeId'
    })

  /** Rename and/or move a library file between folders. */
  router.patch('/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const parsed = updateFileSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid file payload')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row?.ownerBridgeId) throw notFound('File not found')
    assertDemoMutationAllowed(request, row)

    const data: { name?: string; folderId?: string | null; ownerBridgeId?: string | null } = {}
    if (parsed.data.name !== undefined) data.name = parsed.data.name
    if (parsed.data.folderId !== undefined) {
      if (parsed.data.folderId) {
        const parent = await prisma.libraryFolder.findUnique({ where: { id: parsed.data.folderId } })
        if (!parent?.ownerBridgeId) throw notFound('Folder not found')
        data.ownerBridgeId = parent.ownerBridgeId
      } else {
        const targetBridgeId = parsed.data.bridgeId ?? row.ownerBridgeId
        if (!targetBridgeId) throw badRequest('Select a bridge before moving a library file')
        data.ownerBridgeId = targetBridgeId
      }
      data.folderId = parsed.data.folderId
    }
    if (parsed.data.bridgeId !== undefined && parsed.data.folderId == null) {
      const targetBridgeId = parsed.data.bridgeId ?? null
      if (!targetBridgeId) throw badRequest('Select a bridge before moving a library file')
      data.ownerBridgeId = targetBridgeId
    }

    const updated = await prisma.libraryFile.update({ where: { id: row.id }, data })
    annotateRequestAuditLog(request, {
      action: parsed.data.folderId !== undefined && parsed.data.name !== undefined
        ? 'move-rename'
        : parsed.data.folderId !== undefined
          ? 'move'
          : 'rename',
      resource: 'library file',
      summary: parsed.data.folderId !== undefined && parsed.data.name !== undefined
        ? `Renamed and moved library file ${row.name}.`
        : parsed.data.folderId !== undefined
          ? `Moved library file ${row.name}.`
          : `Renamed library file ${row.name} to ${updated.name}.`,
      metadata: {
        fileId: row.id,
        previousName: row.name,
        fileName: updated.name,
        previousFolderId: row.folderId,
        folderId: updated.folderId
      }
    })
    if (!row.hidden) broadcastLibraryChanged()
    response.json({ file: await toDto(updated) })
  })

  const toggleFavoriteSchema = z.object({ favorite: z.boolean() })

  /**
   * Star / unstar a library file for the current user. Favorites are personal, so
   * this needs only view access (anyone who can see the file may favorite it for
   * themselves) and is keyed by the per-user owner key. No workspace-wide broadcast:
   * a favorite change is visible only to the acting user, who invalidates their own
   * library queries client-side.
   */
  router.put('/:id/favorite', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const fileId = requireRouteParam(request.params.id, 'File id')
    const ownerKey = resolveFavoriteOwnerKey(request)
    const parsed = toggleFavoriteSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid favorite payload')

    const row = await prisma.libraryFile.findFirst({ where: visibleLibraryFilesWhere({ id: fileId, workspaceId }) })
    if (!row?.ownerBridgeId) throw notFound('File not found')

    if (parsed.data.favorite) {
      // A favorite has nothing to update, so this is create-or-ignore: a duplicate
      // (already favorited) is an idempotent no-op. (Plain create, not upsert, so it
      // takes the workspace-scoping extension's create path, which injects the workspace id.)
      try {
        await prisma.libraryFileFavorite.create({ data: { workspaceId, userId: ownerKey, libraryFileId: row.id } })
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error
      }
    } else {
      await prisma.libraryFileFavorite.deleteMany({ where: { userId: ownerKey, libraryFileId: row.id } })
    }

    annotateRequestAuditLog(request, {
      action: parsed.data.favorite ? 'favorite' : 'unfavorite',
      resource: 'library file',
      summary: `${parsed.data.favorite ? 'Favorited' : 'Unfavorited'} library file ${row.name}.`,
      metadata: { fileId: row.id, fileName: row.name }
    })
    response.json({ file: await toDto(row, { cacheOnly: true, favorite: parsed.data.favorite }) })
  })
}
