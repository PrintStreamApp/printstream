/* eslint-disable react-refresh/only-export-components -- plugin entry exports a lazy route + panel intentionally */
/**
 * Filament-manager plugin (web side).
 *
 * Adds the top-level **Filament** tab (custom spool icon on mobile) — a spool
 * inventory with search/filter/sort/group, list and icon views, and graphical +
 * numeric remaining-filament. Also contributes the plugin-manager settings panel
 * for the `autoAddBambuSpools` toggle.
 *
 * Spool editing of AMS/external slots (pick-from-library / save-to-library) is
 * contributed separately into the slot editors via plugin slots.
 */
import { Suspense, lazy } from 'react'
import { Typography } from '@mui/joy'
import type { WebPlugin } from '../../plugin/types'
import { FilamentSpoolIcon } from './FilamentSpoolIcon'
import { FilamentManagerSettingsPanel } from './SettingsPanel'
import { SlotEditorActions } from './SlotEditorActions'

const FilamentView = lazy(async () => {
  const module = await import('./FilamentView')
  return { default: module.FilamentView }
})

function FilamentRoute() {
  return (
    <Suspense fallback={<Typography level="body-sm">Loading filament…</Typography>}>
      <FilamentView />
    </Suspense>
  )
}

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
      element: FilamentRoute
    }
  ],
  slots: [
    { name: 'ams.slotEditor', component: SlotEditorActions },
    { name: 'externalSpool.editor', component: SlotEditorActions }
  ]
}
