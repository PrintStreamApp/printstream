/**
 * Printer-storage delete and rename routes.
 *
 * These mutations share the same workspace-owned printer lookup, path boundary, durable audit
 * annotation, 3MF inspection-cache invalidation, and printer-storage change broadcast. The parent
 * registers the whole family before storage print dispatch at its original route position.
 */
import type { Router } from 'express'
import { PRINTERS_MANAGE_STORAGE_EDIT_SCOPE, startPrinterStorageDeleteJobSchema } from '@printstream/shared'
import { annotateRequestAuditLog } from '../lib/audit-logs.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { deleteOperationDispatcher } from '../lib/delete-operation-dispatcher.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { deletePrinterDirectory, deletePrinterFile, renamePrinterPath } from '../lib/printer-ftp.js'
import { clearPrinterStorageThreeMfInspectionCache } from '../lib/printer-storage-3mf.js'
import { requireRouteParam } from '../lib/request-helpers.js'
import { broadcastPrinterStorageChanged } from '../lib/ws-resource-events.js'
import { normalizePrinterPath } from './printer-storage-policy.js'

/** Register direct and queued storage mutations in their existing order. */
export function registerPrinterStorageMutationRoutes(router: Router): void {
  /** DELETE /api/printers/:id/storage?path=/x.3mf&type=file: remove a file or empty directory. */
  router.delete('/:id/storage', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const targetPath = normalizePrinterPath(request.query.path)
    if (targetPath === '/') throw badRequest('Cannot delete root')
    const entryType = request.query.type === 'directory' ? 'directory' : 'file'
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: entryType === 'directory' ? 'printer storage directory' : 'printer storage file',
      summary: `Deleted ${targetPath} from printer storage on ${printer.name}.`,
      metadata: {
        printerId: printer.id,
        printerName: printer.name,
        path: targetPath,
        entryType
      }
    })
    try {
      if (entryType === 'directory') {
        await deletePrinterDirectory(printer, targetPath)
      } else {
        await deletePrinterFile(printer, targetPath)
      }
      clearPrinterStorageThreeMfInspectionCache(printer.id)
      broadcastPrinterStorageChanged(printer.id)
      response.status(204).end()
    } catch (error) {
      throw badRequest((error as Error).message || 'Failed to delete')
    }
  })

  router.post('/:id/storage/delete-jobs', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const parsed = startPrinterStorageDeleteJobSchema.safeParse(request.body)
    if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid delete payload')

    const entries = parsed.data.entries.map((entry) => ({
      path: normalizePrinterPath(entry.path),
      type: entry.type
    }))
    if (entries.some((entry) => entry.path === '/')) throw badRequest('Cannot delete root')

    const job = deleteOperationDispatcher.enqueuePrinterStorageDelete(printer.id, printer.name, entries, request.workspace?.id ?? null)
    annotateRequestAuditLog(request, {
      action: 'delete',
      resource: 'printer storage entry',
      summary: job.totalItems === 1
        ? `Queued delete of printer storage entry ${job.summaryLabel} on ${printer.name}.`
        : `Queued delete of ${job.totalItems} printer storage entries on ${printer.name}.`,
      metadata: {
        deleteOperationId: job.id,
        printerId: printer.id,
        printerName: printer.name,
        entries,
        itemCount: job.totalItems,
        summaryLabel: job.summaryLabel
      }
    })
    response.status(202).json({ job })
  })

  /** POST /api/printers/:id/storage/rename: rename or move a file/folder. */
  router.post('/:id/storage/rename', requireRequestPermission(PRINTERS_MANAGE_STORAGE_EDIT_SCOPE), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const fromPath = normalizePrinterPath((request.body as { from?: unknown })?.from)
    const toPath = normalizePrinterPath((request.body as { to?: unknown })?.to)
    if (fromPath === '/' || toPath === '/') throw badRequest('Invalid rename target')
    annotateRequestAuditLog(request, {
      action: 'rename',
      resource: 'printer storage entry',
      summary: `Renamed printer storage entry on ${printer.name}.`,
      metadata: {
        printerId: printer.id,
        printerName: printer.name,
        fromPath,
        toPath
      }
    })
    try {
      await renamePrinterPath(printer, fromPath, toPath)
      clearPrinterStorageThreeMfInspectionCache(printer.id)
      broadcastPrinterStorageChanged(printer.id)
      response.status(204).end()
    } catch (error) {
      throw badRequest((error as Error).message || 'Failed to rename')
    }
  })
}
