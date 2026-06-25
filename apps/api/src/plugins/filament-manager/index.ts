/**
 * Filament-manager plugin (built-in, API side).
 *
 * Owns a per-workspace spool inventory and keeps it in sync with the printers:
 *
 * - HTTP CRUD for spools (`/api/plugins/filament-manager/spools`), manual
 *   quantity adjustments, slot assignment, recycle/restore, and a consumption
 *   ledger — see `routes.ts`.
 * - Auto-adds RFID-tagged Bambu spools on AMS insert and re-associates known
 *   spools with their current slot, syncing remaining filament from the
 *   printer's remain% — see `status-sync.ts` (gated by the per-tenant
 *   `autoAddBambuSpools` setting, default on).
 * - Decrements non-Bambu spools by per-job grams when a print finishes — see
 *   `consumption.ts`. (Hybrid tracking: Bambu spools use remain%, others use
 *   per-job consumption.)
 *
 * Inventory is structured relational data, so it lives in dedicated Prisma
 * models (`FilamentSpool` / `FilamentSpoolUsage`) rather than the `Setting`
 * store. Live changes fan out over the generic `plugin.event` WS envelope.
 *
 * External deps: none beyond the printer event bus and Prisma.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { registerFilamentManagerRoutes } from './routes.js'
import { createStatusObserver } from './status-sync.js'
import { createConsumptionObserver } from './consumption.js'

export const filamentManagerPlugin: ApiPlugin = {
  name: 'filament-manager',
  version: '0.1.0',
  description: 'Track filament spools: auto-add Bambu spools, see what is loaded where, and watch remaining filament.',
  register(context) {
    registerFilamentManagerRoutes(context)

    const onStatus = createStatusObserver(context)
    const onJobFinished = createConsumptionObserver(context)

    context.printerEvents.on('status', onStatus)
    context.printerEvents.on('print-job.finished', onJobFinished)
    context.onShutdown(() => {
      context.printerEvents.off('status', onStatus)
      context.printerEvents.off('print-job.finished', onJobFinished)
    })
  }
}
