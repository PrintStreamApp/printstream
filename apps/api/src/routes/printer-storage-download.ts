/**
 * Direct printer-storage downloads.
 *
 * The parent registers this route at its original position. It authorizes printer ownership before
 * FTP access, streams under the request abort signal, and destroys a partial response on failure.
 */
import path from 'node:path'
import type { Router } from 'express'
import { PRINTER_STORAGE_DOWNLOAD_PERMISSION } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { streamFileFromPrinter } from '../lib/printer-ftp.js'
import { requestAbortSignal, requireRouteParam } from '../lib/request-helpers.js'
import { normalizePrinterPath, resolvePrinterStorageDownloadContentType } from './printer-storage-policy.js'

/** Register the streaming download endpoint at its existing printer-router position. */
export function registerPrinterStorageDownloadRoute(router: Router): void {
  /** Download a printer-stored file without copying it into the library first. */
  router.get('/:id/storage/download', requireRequestPermission(PRINTER_STORAGE_DOWNLOAD_PERMISSION), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const filePath = normalizePrinterPath(request.query.path)
    if (filePath === '/') throw badRequest('Invalid path')
    const signal = requestAbortSignal(request, response)
    annotateRequestAuditLog(request, {
      action: 'download',
      resource: 'printer storage file',
      summary: `Downloaded ${path.basename(filePath)} from printer storage on ${printer.name}.`,
      metadata: {
        printerId: printer.id,
        printerName: printer.name,
        path: filePath,
        fileName: path.basename(filePath)
      }
    })

    response.type(resolvePrinterStorageDownloadContentType(filePath))
    response.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`)

    try {
      await streamFileFromPrinter(printer, filePath, response, undefined, { signal })
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      if (!response.headersSent) {
        throw badRequest((error as Error).message || 'Failed to download file')
      }
      response.destroy(error as Error)
    }
  })
}
