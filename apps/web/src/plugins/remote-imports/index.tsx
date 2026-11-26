/* eslint-disable react-refresh/only-export-components -- plugin entry exports a lazy route intentionally */
/**
 * Remote imports extend the library Upload menu with direct MakerWorld, Printables,
 * and URL actions. A persistent overlay owns each flow after the menu closes.
 * Legacy `/library/import` and `/import/*` routes preserve printer-menu and browser
 * helper handoffs with candidates / uploadedFile query parameters.
 */
import { Suspense, lazy } from 'react'
import { Typography } from '@mui/joy'
import type { WebPlugin } from '../../plugin/types'
import { LibraryImportMenuAction, PrinterImportMenuAction } from './ImportMenuActions'
import { LibraryImportOverlayHost } from './LibraryImportOverlayHost'
import { RemoteImportsSettingsPanel } from './RemoteImportsSettingsPanel'

const RemoteImportsView = lazy(async () => {
  const module = await import('./RemoteImportsView')
  return { default: module.RemoteImportsView }
})

function RemoteImportsRoute() {
  return (
    <Suspense fallback={<Typography level="body-sm">Loading remote import tools…</Typography>}>
      <RemoteImportsView />
    </Suspense>
  )
}

export const remoteImportsPlugin: WebPlugin = {
  name: 'remote-imports',
  version: '0.1.0',
  description: 'Import printable files from remote URLs and supported model providers.',
  routes: [
    {
      path: '/library/import',
      element: RemoteImportsRoute
    },
    {
      path: '/import/*',
      element: RemoteImportsRoute
    }
  ],
  slots: [
    { name: 'library.upload.menu', component: LibraryImportMenuAction },
    { name: 'shell.overlays', component: LibraryImportOverlayHost },
    { name: 'printers.print.menu', component: PrinterImportMenuAction }
  ],
  settingsPanel: RemoteImportsSettingsPanel
}
