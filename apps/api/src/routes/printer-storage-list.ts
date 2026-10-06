/**
 * Printer storage listing route.
 *
 * The parent registers this at the original position in the printer router. Permission and
 * workspace ownership are checked before FTP access, and request cancellation reaches both
 * recursive and direct directory reads.
 */
import type { Router } from 'express'
import { PRINTER_STORAGE_VIEW_PERMISSION } from '@printstream/shared'
import { badRequest, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { listPrinterDirectory, listPrinterDirectoryRecursive } from '../lib/printer-ftp.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { requestAbortSignal, requireRouteParam } from '../lib/request-helpers.js'
import { normalizePrinterPath, RECURSIVE_SKIP_DIRS } from './printer-storage-policy.js'

/** Register the storage listing endpoint at its existing place in the printer router. */
export function registerPrinterStorageListRoute(router: Router): void {
  /** GET /api/printers/:id/storage?path=/&recursive=1: list files+folders. */
  router.get('/:id/storage', requireRequestPermission(PRINTER_STORAGE_VIEW_PERMISSION), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const dirPath = normalizePrinterPath(request.query.path)
    const recursive = request.query.recursive === '1' || request.query.recursive === 'true'
    const signal = requestAbortSignal(request, response)
    try {
      const entries = recursive
        ? await listPrinterDirectoryRecursive(printer, dirPath, 4, RECURSIVE_SKIP_DIRS, { signal })
        : await listPrinterDirectory(printer, dirPath, { signal })
      response.json({ path: dirPath, entries })
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      throw badRequest((error as Error).message || 'Failed to list directory')
    }
  })
}
