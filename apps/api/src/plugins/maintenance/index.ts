/**
 * Maintenance plugin (built-in, API side).
 *
 * Tracks when each printer is next due for the servicing Bambu recommends for
 * its model — chiefly lubrication and axis care, plus the wear consumables whose
 * intervals Bambu states in rolls of filament. Intervals come from the shared
 * catalog (`@printstream/shared`, `printer-maintenance.ts`), which cites the wiki
 * page each number came from; this plugin owns only persistence and the HTTP
 * surface.
 *
 * Disabled by default: a printer farm wants this, a single hobby printer may not,
 * and it is not part of the basic print loop.
 *
 * Extension surfaces: HTTP routes at `/api/plugins/maintenance` (`routes.ts`).
 * External deps: none. It reads live printer status through `printerManager`
 * (for the HMS codes that mean the machine is asking for a service) and lifetime
 * usage from the core `PrinterStats` table — no other plugin is involved.
 */
import type { ApiPlugin } from '../../plugin/types.js'
import { registerMaintenanceRoutes } from './routes.js'

export const maintenancePlugin: ApiPlugin = {
  name: 'maintenance',
  version: '0.1.0',
  description: "Track when each printer is next due for lubrication and other maintenance Bambu recommends for its model.",
  register(context) {
    registerMaintenanceRoutes(context)
  }
}
