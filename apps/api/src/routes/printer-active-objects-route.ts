/**
 * Active print-object listing for a printer's current job.
 *
 * Cached objects are returned with the persisted job's exact printer-file path when available.
 * A cache miss begins best-effort preload and returns `loading` without blocking the request.
 * The parent registers this route before cover and storage media paths.
 */
import type { Router } from 'express'
import { PRINTERS_VIEW_PERMISSION, printerActivePrintObjectsSchema } from '@printstream/shared'
import { getActivePrintJobAssets } from '../lib/active-print-job-assets.js'
import {
  getCachedActivePrintObjects,
  inferActivePrintObjectsUnavailableState,
  preloadActivePrintObjects
} from '../lib/active-print-objects.js'
import { requireRequestPermission } from '../lib/authorization.js'
import { notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { choosePreferredExactPrinterFilePath } from '../lib/printer-file-path.js'
import { printerManager } from '../lib/printer-manager.js'
import { requireRouteParam } from '../lib/request-helpers.js'

/** Register the active-object read endpoint at its original printer-router position. */
export function registerPrinterActiveObjectsRoute(router: Router): void {
  router.get('/:id/active-print-objects', requireRequestPermission(PRINTERS_VIEW_PERMISSION), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')

    const status = printerManager.getStatus(printer.id)
    const jobName = status?.jobName ?? printerManager.getLastJobName(printer.id)
    if (!jobName) {
      response.json(printerActivePrintObjectsSchema.parse({ objects: [], loading: false }))
      return
    }

    const gcodeFile = status?.gcodeFile ?? null
    const taskId = status?.taskId ?? null
    const cached = getCachedActivePrintObjects(printer.id, jobName, gcodeFile, taskId)
    if (cached) {
      const persistedJob = taskId ? await getActivePrintJobAssets(printer.id, taskId) : null
      const unavailableGcodeFile = choosePreferredExactPrinterFilePath(gcodeFile, persistedJob?.printerFilePath) ?? gcodeFile
      const unavailableState = inferActivePrintObjectsUnavailableState(printer, unavailableGcodeFile, cached)

      response.json(printerActivePrintObjectsSchema.parse({
        objects: cached,
        loading: false,
        unavailableReason: unavailableState?.unavailableReason ?? null,
        unavailableMessage: unavailableState?.unavailableMessage ?? null
      }))
      return
    }

    void preloadActivePrintObjects(printer.id, {
      jobName,
      gcodeFile,
      taskId
    })

    response.json(printerActivePrintObjectsSchema.parse({
      objects: [],
      loading: true,
      unavailableReason: null,
      unavailableMessage: null
    }))
  })
}
