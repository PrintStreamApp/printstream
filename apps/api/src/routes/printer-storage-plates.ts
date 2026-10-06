/**
 * Project metadata for a 3MF stored on the printer.
 *
 * The route projects the parsed index into the printer-storage wire response field by field.
 * Keep new index fields here when the print dialog needs them; the projection intentionally
 * replaces thumbnail paths with presence flags while preserving plate and switch policy inputs.
 */
import path from 'node:path'
import type { Router } from 'express'
import { extractErrorMessage, PRINTER_STORAGE_VIEW_MODELS_SCOPE, type ThreeMfIndex } from '@printstream/shared'
import { requireRequestPermission } from '../lib/authorization.js'
import { badRequest, notFound } from '../lib/http-error.js'
import { requireWorkspaceOwnedConnectedPrinter } from '../lib/printer-access.js'
import { readPrinterStorageThreeMfIndex } from '../lib/printer-storage-3mf.js'
import { requestAbortSignal, requireRouteParam } from '../lib/request-helpers.js'
import { normalizePrinterPath } from './printer-storage-policy.js'

/** Register the printer-stored 3MF metadata endpoint at its original position. */
export function registerPrinterStoragePlatesRoute(router: Router): void {
  /** Plate index for a 3MF already stored on the printer. */
  router.get('/:id/storage/plates', requireRequestPermission(PRINTER_STORAGE_VIEW_MODELS_SCOPE), async (request, response) => {
    const printer = await requireWorkspaceOwnedConnectedPrinter(requireRouteParam(request.params.id, 'Printer id'))
    if (!printer) throw notFound('Printer not found or not connected')
    const filePath = normalizePrinterPath(request.query.path)
    const signal = requestAbortSignal(request, response)
    if (path.extname(filePath).toLowerCase() !== '.3mf') {
      response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, processProfileInherits: null } satisfies ThreeMfIndex)
      return
    }

    try {
      const index = await readPrinterStorageThreeMfIndex(printer, filePath, signal)
      if (!index) {
        response.json({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, processProfileInherits: null } satisfies ThreeMfIndex)
        return
      }
      response.json({
        plates: index.plates.map((plate) => ({
          index: plate.index,
          name: plate.name,
          hasThumbnail: plate.thumbnailFile != null,
          plateType: plate.plateType,
          // The plate's OWN settings, beside its resolved `plateType`. Repeated here for the same
          // reason as the note below: this response is projected field by field, so a per-plate
          // setting the editor writes is invisible when the same file is printed off the printer's
          // own SD card unless it is named here too.
          bedTypeOverride: plate.bedTypeOverride,
          printSequence: plate.printSequence,
          spiralMode: plate.spiralMode,
          locked: plate.locked,
          nozzleSizes: plate.nozzleSizes,
          filaments: plate.filaments,
          objects: plate.objects,
          // The Filament Track Switch arrangement hint reads this; see the note below on why every
          // index field has to be repeated here.
          optimalAssignment: plate.optimalAssignment
        })),
        projectFilaments: index.projectFilaments,
        projectPlateType: index.projectPlateType,
        compatiblePrinterModels: index.compatiblePrinterModels,
        supportFilamentIds: index.supportFilamentIds,
        printerProfileName: index.printerProfileName,
        processProfileName: index.processProfileName,
        processProfileInherits: index.processProfileInherits,
        // The print dialog warns when this disagrees with the machine, so it has to survive the
        // narrowing above. Plate entries are reshaped here (`hasThumbnail` replaces the file name),
        // which is why this response is projected field by field rather than passed through: when
        // you add an index field, add it here too or the dialog silently never sees it.
        slicedWithFilamentTrackSwitch: index.slicedWithFilamentTrackSwitch
      } satisfies ThreeMfIndex)
    } catch (error) {
      if ((error as Error).name === 'AbortError') return
      throw badRequest(extractErrorMessage(error, 'Failed to read print file metadata'))
    }
  })
}
