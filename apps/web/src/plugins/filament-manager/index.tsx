/**
 * Filament-manager plugin (web side).
 *
 * Adds the top-level **Filament** tab (custom spool icon on mobile) — a spool
 * inventory with search/filter/sort/group, list and icon views, and graphical +
 * numeric remaining-filament. Also contributes the plugin-manager settings panel
 * for the `autoAddBambuSpools` toggle, and the filament stats cards into the stats slot.
 *
 * Eager-loaded with the app shell. (The @mui/x-charts dependency the stats cards use is
 * already in the shell via the core printer/tenant stats, so this adds no bundle weight.)
 *
 * Spool editing of AMS/external slots (pick-from-library / save-to-library) is
 * contributed separately into the slot editors via plugin slots.
 */
import type { WebPlugin } from '../../plugin/types'
import { FilamentSpoolIcon } from '../../components/FilamentSpoolIcon'
import { FilamentManagerSettingsPanel } from './SettingsPanel'
import { SlotEditorActions } from './SlotEditorActions'
import { AmsSlotFilamentIdentity } from './AmsSlotFilamentIdentity'
import { FilamentView } from './FilamentView'
import { FilamentStatsCards } from './FilamentStatsCards'

export const filamentManagerPlugin: WebPlugin = {
  name: 'filament-manager',
  version: '0.1.0',
  description: 'Track filament spools, what is loaded where, and how much is left.',
  settingsPanel: FilamentManagerSettingsPanel,
  routes: [
    {
      path: '/filament/*',
      navLabel: 'Filament',
      navMobileIcon: <FilamentSpoolIcon />,
      element: FilamentView
    }
  ],
  slots: [
    { name: 'ams.slotEditor', component: SlotEditorActions },
    { name: 'externalSpool.editor', component: SlotEditorActions },
    { name: 'printer.amsSlot.filamentIdentity', component: AmsSlotFilamentIdentity },
    { name: 'stats.cards', component: FilamentStatsCards }
  ]
}
