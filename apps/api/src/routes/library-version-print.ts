/**
 * Print an archived library version without changing the current file.
 *
 * The parent registers this static version route before current-file id routes. Dispatch and
 * printing safeguards remain in library-printing; this route validates the request and records
 * the historical version and any accepted safety overrides in the audit trail.
 */
import type { Router } from 'express'
import { PRINTS_DISPATCH_PERMISSION, printFromLibrarySchema } from '@printstream/shared'
import { annotateRequestAuditLog, printOverrideAuditMetadata } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { enqueueLibraryPrintSource } from '../lib/library-printing.js'
import { prisma } from '../lib/prisma.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'

/** Register archived-version dispatch before current-file id routes. */
export function registerLibraryVersionPrintRoute(router: Router): void {
  router.post('/versions/:versionId/print', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const versionId = requireRouteParam(request.params.versionId, 'Version id')
    const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
    if (!parsed.success) {
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid print payload')
    }
    const version = await prisma.libraryFileVersion.findUnique({ where: { id: versionId } })
    if (!version) throw notFound('Version not found')
    const job = await enqueueLibraryPrintSource({
      fileId: version.libraryFileId,
      ...parsed.data
    }, {
      fileId: version.libraryFileId,
      id: version.id,
      workspaceId: version.workspaceId,
      name: version.name,
      ownerBridgeId: version.ownerBridgeId,
      storedPath: version.storedPath,
      sizeBytes: version.sizeBytes,
      kind: version.kind,
      snapshotKey: null,
      // An archived version has no preserved project of its own: the re-slice link is
      // recorded per sliced output, and this dispatches historical bytes instead.
      sourceTagSnapshotJson: version.sourceTagSnapshotJson ?? null,
      sourceProjectFileId: null,
      sliceSettingsJson: null
    })
    annotateRequestAuditLog(request, {
      action: 'start-print-version',
      resource: 'print job',
      summary: `Queued print ${job.jobName} from version ${version.versionNumber} on ${job.printerName}.`,
      metadata: {
        jobId: job.id,
        printerId: job.printerId,
        printerName: job.printerName,
        fileId: version.libraryFileId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        fileName: version.name,
        plate: job.plate,
        ...printOverrideAuditMetadata(parsed.data)
      }
    })
    broadcastPrintDispatchChanged(version.workspaceId)
    response.status(202).json({ job })
  })
}
