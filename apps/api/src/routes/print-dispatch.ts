/**
 * Print dispatcher API.
 *
 * Exposes in-memory dispatch jobs created when the user sends a library
 * file to one or more printers. Jobs survive browser disconnects while
 * the API process is running and can be cancelled before their MQTT
 * start command is sent.
 */
import { Router } from 'express'
import {
  JOBS_VIEW_PERMISSION,
  PRINTS_DISPATCH_PERMISSION
} from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { notFound } from '../lib/http-error.js'
import { printDispatcher } from '../lib/print-dispatcher.js'
import { requireRequestTenantId, requireRouteParam } from '../lib/request-helpers.js'
import { broadcastPrintDispatchChanged } from '../lib/ws-resource-events.js'
import { requireRequestPermission } from '../lib/authorization.js'

export const printDispatchRouter = Router()

printDispatchRouter.get('/', requireRequestPermission(JOBS_VIEW_PERMISSION), (request, response) => {
  response.json({ jobs: printDispatcher.list(requireRequestTenantId(request)) })
})

printDispatchRouter.post('/:id/cancel', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), async (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const job = await printDispatcher.cancel(tenantId, requireRouteParam(request.params.id, 'Dispatch job'))
  if (!job) throw notFound('Dispatch job not found')
  annotateRequestAuditLog(request, {
    action: 'cancel-dispatch',
    resource: 'print dispatch',
    summary: `Cancelled dispatch ${job.jobName} for ${job.printerName}.`,
    metadata: {
      jobId: job.id,
      printerId: job.printerId,
      printerName: job.printerName,
      fileId: job.fileId,
      fileName: job.fileName
    }
  })
  broadcastPrintDispatchChanged(tenantId)
  response.json({ job })
})

printDispatchRouter.post('/:id/retry', requireRequestPermission(PRINTS_DISPATCH_PERMISSION), (request, response) => {
  const tenantId = requireRequestTenantId(request)
  const job = printDispatcher.retry(tenantId, requireRouteParam(request.params.id, 'Dispatch job'))
  if (!job) throw notFound('Dispatch job not found')
  annotateRequestAuditLog(request, {
    action: 'retry-dispatch',
    resource: 'print dispatch',
    summary: `Retried dispatch ${job.jobName} for ${job.printerName}.`,
    metadata: {
      jobId: job.id,
      printerId: job.printerId,
      printerName: job.printerName,
      fileId: job.fileId,
      fileName: job.fileName
    }
  })
  broadcastPrintDispatchChanged(tenantId)
  response.json({ job })
})
