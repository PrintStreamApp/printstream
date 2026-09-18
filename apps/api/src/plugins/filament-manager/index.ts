/**
 * Filament-manager plugin (built-in, API side).
 *
 * Owns a per-workspace spool inventory and keeps it in sync with the printers:
 *
 * - HTTP CRUD for spools (`/api/plugins/filament-manager/spools`), manual
 *   quantity adjustments, slot assignment, recycle/restore, and a consumption
 *   ledger: see `routes.ts`.
 * - Auto-adds RFID-tagged Bambu spools on AMS insert and re-associates known
 *   spools with their current slot, syncing remaining filament from the
 *   printer's remain%: see `status-sync.ts` (gated by the per-workspace
 *   `autoAddBambuSpools` setting, default on).
 * - Decrements non-Bambu spools by per-job grams when a print finishes: see
 *   `consumption.ts`. (Hybrid tracking: Bambu spools use remain%, others use
 *   per-job consumption.)
 *
 * Inventory is structured relational data, so it lives in dedicated Prisma
 * models (`FilamentSpool` / `FilamentSpoolUsage`) rather than the `Setting`
 * store. Live changes fan out over the generic `plugin.event` WS envelope.
 *
 * External deps: the Open Filament Database JSON catalog, fetched lazily and cached in memory for
 * barcode lookup. Scanned codes stay local to the API.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { rootPrisma } from '../../lib/prisma.js'
import { registerFilamentManagerRoutes } from './routes.js'
import { createStatusObserver } from './status-sync.js'
import { createConsumptionObserver } from './consumption.js'
import { broadcastSpoolsChanged } from './events.js'
import { findLoadedSpoolIdentity } from './store.js'
import { FilamentBarcodeCatalog } from './barcode-catalog.js'

export const filamentManagerPlugin: ApiPlugin = {
  name: 'filament-manager',
  version: '0.1.0',
  description: 'Track filament spools: auto-add Bambu spools, see what is loaded where, and watch remaining filament.',
  register(context) {
    const barcodeCatalog = new FilamentBarcodeCatalog(context.logger)
    registerFilamentManagerRoutes(context, barcodeCatalog)

    const onStatus = createStatusObserver(context)
    const onJobFinished = createConsumptionObserver(context)

    context.printerEvents.on('status', onStatus)
    context.printerEvents.on('print-job.finished', onJobFinished)

    // Expose "which spool is loaded in this slot" to other plugins (calibration ties a run to the
    // loaded spool) without them importing this plugin. Uses rootPrisma with an explicit workspace
    // filter since the resolver runs outside a per-request scope.
    const offResolver = context.registerSlotFilamentResolver(({ workspaceId, printerId, amsId, slotId }) =>
      findLoadedSpoolIdentity(rootPrisma, workspaceId, printerId, amsId, slotId),
      async ({ workspaceId, printerId, amsId, slotId }) => {
        await rootPrisma.filamentSpool.updateMany({
          where: { workspaceId, loadedPrinterId: printerId, loadedAmsId: amsId, loadedSlotId: slotId },
          data: { loadedPrinterId: null, loadedAmsId: null, loadedSlotId: null, loadedAt: null }
        })
        broadcastSpoolsChanged(context, workspaceId)
      })

    context.onShutdown(() => {
      context.printerEvents.off('status', onStatus)
      context.printerEvents.off('print-job.finished', onJobFinished)
      offResolver()
    })
  }
}
