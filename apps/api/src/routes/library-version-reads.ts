/**
 * Read-only library version routes.
 *
 * The parent library router registers the list and media families at their
 * ordered seams. Every lookup remains workspace-scoped through `prisma`; the
 * parent supplies its shared DTO and stream helpers so current and archived
 * files use the same response policy.
 */
import type { LibraryFile as LibraryFileModel, LibraryFileVersion as LibraryFileVersionModel } from '@prisma/client'
import type { Request, Response, Router } from 'express'
import { z } from 'zod'
import {
  LIBRARY_DOWNLOAD_PERMISSION,
  LIBRARY_VIEW_PERMISSION,
  libraryFileVersionsResponseSchema,
  type LibraryFileVersion as LibraryFileVersionDto
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { requestAbortSignal, requireRouteParam, sendModelBuffer } from '../lib/request-helpers.js'
import { readEntry } from '../lib/three-mf.js'

type VersionMedia = {
  sendDownload: (response: Response, row: LibraryFileVersionModel) => Promise<void>
  sendPlates: (request: Request, response: Response, row: LibraryFileVersionModel) => Promise<void>
  sendThumbnail: (request: Request, response: Response, row: LibraryFileVersionModel) => Promise<void>
  sendArchive: (request: Request, response: Response, row: LibraryFileVersionModel) => Promise<void>
  sendScene: (request: Request, response: Response, row: LibraryFileVersionModel) => Promise<void>
  sendPlateGcode: (request: Request, response: Response, row: LibraryFileVersionModel) => Promise<void>
  resolveLocalPath: (row: { ownerBridgeId?: string | null; storedPath: string }) => Promise<string>
  sendNotModified: (request: Request, response: Response, row: LibraryFileVersionModel, variant: string) => boolean
}

/** Resolve a version inside the active request workspace before any media read. */
async function versionForRequest(request: Request): Promise<LibraryFileVersionModel> {
  const versionId = requireRouteParam(request.params.versionId, 'Version id')
  const row = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } })
  if (!row) throw notFound('Version not found')
  return row
}

/** Register history listing where the parent previously declared it. */
export function registerLibraryVersionListRoute(
  router: Router,
  toVersionDto: (row: LibraryFileModel | LibraryFileVersionModel) => Promise<LibraryFileVersionDto>
): void {
  router.get('/:id/versions', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw notFound('File not found')
    const historyRows = await prisma.libraryFileVersion.findMany({
      where: { libraryFileId: row.id },
      orderBy: { versionNumber: 'desc' }
    })
    response.json(libraryFileVersionsResponseSchema.parse({
      currentFileId: row.id,
      versions: [
        await toVersionDto(row),
        ...await Promise.all(historyRows.map((version) => toVersionDto(version)))
      ]
    }))
  })
}

/** Register archived media reads before the parent resumes current-file media routes. */
export function registerLibraryVersionMediaRoutes(router: Router, media: VersionMedia): void {
  router.get('/versions/:versionId/download', requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION), async (request, response) => {
    const row = await versionForRequest(request)
    annotateRequestAuditLog(request, {
      action: 'download-version',
      resource: 'library file',
      summary: `Downloaded version ${row.versionNumber} of ${row.name}.`,
      metadata: {
        versionId: row.id,
        fileId: row.libraryFileId,
        fileName: row.name,
        sizeBytes: row.sizeBytes
      }
    })
    await media.sendDownload(response, row)
  })

  router.get('/versions/:versionId/plates', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendPlates(request, response, await versionForRequest(request))
  })

  router.get('/versions/:versionId/thumbnail', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendThumbnail(request, response, await versionForRequest(request))
  })

  /** The whole archived 3MF, for a client that parses it itself. */
  router.get('/versions/:versionId/archive', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendArchive(request, response, await versionForRequest(request))
  })

  router.get('/versions/:versionId/scene', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendScene(request, response, await versionForRequest(request))
  })

  router.get('/versions/:versionId/plate-gcode', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendPlateGcode(request, response, await versionForRequest(request))
  })

  /** Raw internal 3MF model entry bytes for the archived-version previewer. */
  router.get('/versions/:versionId/scene-entry', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const row = await versionForRequest(request)
    // Bambu sub-model part files and the root model both carry renderable object geometry.
    const entryPath = z.string().trim().regex(/^3D\/(?:Objects\/[^/]+\.model|3dmodel\.model)$/i).parse(request.query.path)
    if (media.sendNotModified(request, response, row, `scene-entry:${entryPath}`)) return

    let onDisk: string
    try {
      onDisk = await media.resolveLocalPath(row)
    } catch {
      throw notFound('File missing on disk')
    }

    const signal = requestAbortSignal(request, response)
    try {
      const buffer = await readEntry(onDisk, entryPath, signal, 256 * 1024 * 1024)
      if (signal.aborted) return
      await sendModelBuffer(request, response, buffer, 'application/xml; charset=utf-8')
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      throw notFound('Scene model entry missing')
    }
  })
}
