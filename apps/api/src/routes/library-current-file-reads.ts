/**
 * Current library-file download and simple media routes.
 *
 * The parent registers these at their existing ordered seams. Each handler
 * resolves a file through the workspace-scoped Prisma client and delegates
 * response policy to the same helpers used for archived versions.
 */
import type { LibraryFile } from '@prisma/client'
import type { Request, Response, Router } from 'express'
import { LIBRARY_DOWNLOAD_PERMISSION, LIBRARY_VIEW_PERMISSION, type LibraryFile as LibraryFileDto } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { notFound } from '../lib/http-error.js'
import { prisma } from '../lib/prisma.js'
import { requireRouteParam } from '../lib/request-helpers.js'

type CurrentFileMedia = {
  sendPlates: (request: Request, response: Response, row: LibraryFile) => Promise<void>
  sendPlateGcode: (request: Request, response: Response, row: LibraryFile) => Promise<void>
  sendArchive: (request: Request, response: Response, row: LibraryFile) => Promise<void>
  sendScene: (request: Request, response: Response, row: LibraryFile) => Promise<void>
  sendThumbnail: (request: Request, response: Response, row: LibraryFile) => Promise<void>
}

/** Resolve a current file inside the active request workspace. */
async function currentFileForRequest(request: Request): Promise<LibraryFile> {
  const fileId = requireRouteParam(request.params.id, 'File id')
  const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
  if (!row) throw notFound('File not found')
  return row
}

/** Keep download before the parent registers its download-link family. */
export function registerLibraryCurrentFileDownloadRoute(
  router: Router,
  sendDownload: (response: Response, row: LibraryFile) => Promise<void>
): void {
  router.get('/:id/download', requireRequestPermission(LIBRARY_DOWNLOAD_PERMISSION), async (request, response) => {
    const row = await currentFileForRequest(request)
    annotateRequestAuditLog(request, {
      action: 'download',
      resource: 'library file',
      summary: `Downloaded library file ${row.name}.`,
      metadata: {
        fileId: row.id,
        fileName: row.name,
        sizeBytes: row.sizeBytes
      }
    })
    await sendDownload(response, row)
  })
}

/** Register media paths that simply call shared current/archived send helpers. */
export function registerLibraryCurrentFileMediaRoutes(router: Router, media: CurrentFileMedia): void {
  router.get('/:id/plates', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendPlates(request, response, await currentFileForRequest(request))
  })

  router.get('/:id/plate-gcode', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendPlateGcode(request, response, await currentFileForRequest(request))
  })

  router.get('/:id/archive', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendArchive(request, response, await currentFileForRequest(request))
  })

  router.get('/:id/scene', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendScene(request, response, await currentFileForRequest(request))
  })

  router.get('/:id/thumbnail', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    await media.sendThumbnail(request, response, await currentFileForRequest(request))
  })
}

/** Register the editor's version probe and full file DTO at the parent's late file-id seam. */
export function registerLibraryCurrentFileMetadataRoutes(
  router: Router,
  toDto: (row: LibraryFile) => Promise<LibraryFileDto>
): void {
  router.get('/:id/current-version', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    const fileId = requireRouteParam(request.params.id, 'File id')
    const row = await prisma.libraryFile.findUnique({
      where: { id: fileId },
      select: { currentVersionNumber: true }
    })
    if (!row) throw notFound('File not found')
    response.json({ currentVersionNumber: row.currentVersionNumber })
  })

  router.get('/:id', requireRequestPermission(LIBRARY_VIEW_PERMISSION), async (request, response) => {
    response.json({ file: await toDto(await currentFileForRequest(request)) })
  })
}
