/**
 * Maintenance plugin (web side).
 *
 * Adds a "Maintenance" section to the printer detail page and an overdue chip to
 * the printer card header. No top-level tab: this is per-printer information and
 * belongs beside the printer's other facts, not in its own destination.
 *
 * Intervals and their sourcing come from the shared catalog
 * (`@printstream/shared`, `printer-maintenance.ts`); this surface only renders
 * what the API resolved. Both components read `props` defensively and render
 * `null` without a printer id, per the slot contract.
 *
 * Extension surfaces: `printer.detail.sections`, `printer.card.headerChips`.
 * External deps: none.
 */
import type { WebPlugin } from '../../plugin/types'
import { MaintenanceChip } from './MaintenanceChip'
import { MaintenanceSection } from './MaintenanceSection'

export const maintenanceWebPlugin: WebPlugin = {
  name: 'maintenance',
  version: '0.1.0',
  description: 'Track when each printer is next due for lubrication and other maintenance Bambu recommends for its model.',
  slots: [
    { name: 'printer.detail.sections', component: MaintenanceSection },
    { name: 'printer.card.headerChips', component: MaintenanceChip }
  ]
}
