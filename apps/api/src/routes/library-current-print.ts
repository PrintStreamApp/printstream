/**
 * Print dispatch for the current library file.
 *
 * The parent registers this after static version and upload paths. The route validates the
 * request, delegates the guarded dispatch, and records accepted safety overrides in its audit.
 */
import type { Router } from 'express'
import { PRINTS_DISPATCH_PERMISSION, printFromLibrarySchema } from '@printstream/shared'
import { annotateRequestAuditLog, printOverrideAuditMetadata } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest } from '../lib/http-error.js'
import { enqueueLibraryPrint } from '../lib/library-printing.js'
import { requireRequestWorkspaceId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'

/** Enqueue one current-file print and return when the dispatcher accepts it. */
export function registerLibraryCurrentPrintRoute(router: Router): void {
  router.post('/:id/print', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
    const workspaceId = requireRequestWorkspaceId(request)
    const fileId = requireRouteParam(request.params.id, 'File id')
    const parsed = printFromLibrarySchema.omit({ fileId: true }).safeParse(request.body)
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? 'Invalid print payload'
      // A boundary rejection starts no job, so log its reason for self-hosted diagnosis.
      console.warn(`[dispatch] print payload rejected for file ${fileId}: ${reason}`)
      throw badRequest(reason)
    }

    const job = await enqueueLibraryPrint({ fileId, ...parsed.data }, workspaceId)
    annotateRequestAuditLog(request, {
      action: 'start-print',
      resource: 'print job',
      summary: `Queued print ${job.jobName} on ${job.printerName}.`,
      metadata: {
        jobId: job.id,
        printerId: job.printerId,
        printerName: job.printerName,
        fileId: job.fileId,
        fileName: job.fileName,
        plate: job.plate,
        ...printOverrideAuditMetadata(parsed.data)
      }
    })
    broadcastPrintDispatchChanged(workspaceId)
    response.status(202).json({ job })
  })
}
