/**
 * Folder routes for the workspace library.
 *
 * Registered before file-id routes by `library.ts`, so `/folders` cannot be treated as a file id.
 * The parent supplies the demo mutation policy used by every library write surface.
 */
import type { Request, Router } from 'express'
import { z } from 'zod'
import { LIBRARY_MANAGE_PERMISSION, LIBRARY_VIEW_PERMISSION, type LibraryFolder } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { prisma } from '../lib/prisma.js'
import { isUniqueConstraintError } from '../lib/prisma-errors.js'
import { badRequest, conflict, notFound } from '../lib/http-error.js'
import { deleteLibraryFolderTree } from '../lib/library-files.js'
import { broadcastLibraryChanged } from '../lib/ws-resource-events.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'

/** Register folder CRUD routes in their existing order before any file-id routes. */
export function registerLibraryFolderRoutes(
  router: Router,
  assertDemoLibraryFileMutationAllowed: (request: Request, row: { hidden: boolean }) => void
): void {
  /** List all folders. The web client builds the tree client-side from `parentId`. */
  router.get('/folders', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const bridgeId = parseBridgeQuery(request.query.bridgeId)
    const workspaceId = request.workspace?.id ?? null
    const where: Record<string, unknown> = bridgeId ? { ownerBridgeId: bridgeId } : { ownerBridgeId: { not: null } }
    if (workspaceId) where.workspaceId = workspaceId
    const rows = await prisma.libraryFolder.findMany({
      where,
      orderBy: { name: 'asc' }
    })
    response.json({ folders: rows.map(toFolderDto) })
  })

  const createFolderSchema = z.object({
    name: z.string().trim().min(1).max(120),
    bridgeId: z.string().trim().min(1).optional(),
    parentId: z.string().nullable().optional()
  })

  router.post('/folders', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const parsed = createFolderSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid folder payload')
    const workspaceId = requireRequestWorkspaceId(request)
    const parentId = parsed.data.parentId ?? null
    let ownerBridgeId: string | null = parsed.data.bridgeId ?? null
    if (parentId) {
      const parent = await prisma.libraryFolder.findUnique({ where: { id: parentId } })
      if (!parent?.ownerBridgeId) throw notFound('Parent folder not found')
      ownerBridgeId = parent.ownerBridgeId
    }
    if (!ownerBridgeId) throw badRequest('Select a bridge before creating a folder')
    try {
      const created = await prisma.libraryFolder.create({
        data: { workspaceId, ownerBridgeId, name: parsed.data.name, parentId }
      })
      annotateRequestAuditLog(request, {
        action: 'create-folder',
        resource: 'library folder',
        summary: `Created library folder ${created.name}.`,
        metadata: {
          folderId: created.id,
          folderName: created.name,
          parentId: created.parentId
        }
      })
      broadcastLibraryChanged()
      response.status(201).json({ folder: toFolderDto(created) })
    } catch (error) {
      if (isUniqueConstraintError(error)) throw conflict('A folder with that name already exists here')
      throw error
    }
  })

  const updateFolderSchema = z
    .object({
      bridgeId: z.string().trim().min(1).nullable().optional(),
      name: z.string().trim().min(1).max(120).optional(),
      parentId: z.string().nullable().optional()
    })
    .refine((data) => data.name !== undefined || data.parentId !== undefined || data.bridgeId !== undefined, {
      message: 'Provide name, parentId, or bridgeId'
    })

  /** Rename and/or move a folder. Moving into a descendant is rejected. */
  router.patch('/folders/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const folderId = requireRouteParam(request.params.id, 'Folder id')
    const parsed = updateFolderSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid folder payload')
    const folder = await prisma.libraryFolder.findUnique({ where: { id: folderId } })
    if (!folder?.ownerBridgeId) throw notFound('Folder not found')

    const data: { name?: string; parentId?: string | null; ownerBridgeId?: string | null } = {}
    if (parsed.data.name !== undefined) data.name = parsed.data.name
    if (parsed.data.parentId !== undefined) {
      const newParentId = parsed.data.parentId
      if (newParentId === folder.id) throw badRequest('A folder cannot be its own parent')
      if (newParentId) {
        const parent = await prisma.libraryFolder.findUnique({ where: { id: newParentId } })
        if (!parent?.ownerBridgeId) throw notFound('Parent folder not found')
        if (parent.ownerBridgeId !== folder.ownerBridgeId) {
          throw badRequest('Folders cannot be moved across bridge roots')
        }
        if (await isDescendant(newParentId, folder.id)) {
          throw badRequest('Cannot move a folder into one of its descendants')
        }
      }
      data.parentId = newParentId
    }
    if (parsed.data.bridgeId !== undefined) {
      const nextBridgeId = parsed.data.bridgeId ?? null
      if (!nextBridgeId) throw badRequest('Select a bridge before moving a folder')
      if (nextBridgeId !== folder.ownerBridgeId) {
        throw badRequest('Folders cannot be moved across bridge roots')
      }
      data.ownerBridgeId = nextBridgeId
    }

    try {
      const updated = await prisma.libraryFolder.update({ where: { id: folder.id }, data })
      const renamed = parsed.data.name !== undefined && updated.name !== folder.name
      const moved = parsed.data.parentId !== undefined
      annotateRequestAuditLog(request, {
        action: renamed && moved ? 'move-rename-folder' : moved ? 'move-folder' : 'rename-folder',
        resource: 'library folder',
        summary: renamed && moved
          ? `Renamed and moved library folder ${folder.name}.`
          : moved
            ? `Moved library folder ${updated.name}.`
            : `Renamed library folder ${folder.name} to ${updated.name}.`,
        metadata: {
          folderId: folder.id,
          previousName: folder.name,
          folderName: updated.name,
          previousParentId: folder.parentId,
          parentId: updated.parentId
        }
      })
      broadcastLibraryChanged()
      response.json({ folder: toFolderDto(updated) })
    } catch (error) {
      if (isUniqueConstraintError(error)) throw conflict('A folder with that name already exists here')
      throw error
    }
  })

  /**
   * Delete a folder. Refuses when it has contents unless `?recursive=true`, in
   * which case the whole subtree, descendant folders, files, and version
   * history, is removed (the client confirms with the user first).
   */
  router.delete('/folders/:id', requireRequestPermission(LIBRARY_MANAGE_PERMISSION), async (request, response) => {
    const folderId = requireRouteParam(request.params.id, 'Folder id')
    const recursive = request.query.recursive === 'true'
    const folder = await prisma.libraryFolder.findUnique({
      where: { id: folderId },
      include: { _count: { select: { files: true, children: true } } }
    })
    if (!folder) throw notFound('Folder not found')
    if (!recursive && (folder._count.files > 0 || folder._count.children > 0)) {
      throw conflict('Folder is not empty')
    }
    const { deletedFiles } = await deleteLibraryFolderTree(folder.id, {
      assertFileDeletable: (row) => assertDemoLibraryFileMutationAllowed(request, row)
    })
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: 'library folder',
      summary: deletedFiles > 0
        ? `Deleted library folder ${folder.name} and moved ${deletedFiles} file${deletedFiles === 1 ? '' : 's'} inside it to the recycle bin.`
        : `Deleted library folder ${folder.name}.`,
      metadata: { folderId: folder.id, folderName: folder.name, recursive, deletedFiles }
    })
    response.status(204).end()
  })
}

/** Expose only the stable folder identity and hierarchy fields to the browser. */
export function toFolderDto(row: { id: string; name: string; parentId: string | null }): LibraryFolder {
  return { id: row.id, name: row.name, parentId: row.parentId }
}

/**
 * Parse an optional bridge filter. Missing, blank, and non-string values mean
 * that the caller did not select a bridge.
 */
export function parseBridgeQuery(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

async function isDescendant(candidateId: string, ancestorId: string): Promise<boolean> {
  let current: string | null = candidateId
  // Bounded walk: folder trees are tiny and parentId chains terminate at null.
  for (let depth = 0; depth < 64 && current; depth++) {
    if (current === ancestorId) return true
    const parent: { parentId: string | null } | null = await prisma.libraryFolder.findUnique({
      where: { id: current },
      select: { parentId: true }
    })
    if (!parent) return false
    current = parent.parentId
  }
  return false
}
