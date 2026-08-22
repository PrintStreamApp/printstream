/* eslint-disable react-refresh/only-export-components -- plugin entry exports a lazy route intentionally */
/**
 * Remote imports plugin (web side).
 *
 * Imported files land in the bridge-backed library, so this is a library surface, not its own
 * top-level section: the import sub-view at `/library/import` is where users paste provider
 * URLs, review detection results, and import.
 *
 * Reached from MENU entries on the surfaces that already do this job — the library's Upload
 * split button and the printers page's Print split button — rather than a toolbar button of
 * its own. Importing from a URL is another way to do what those controls already do, so a
 * third adjacent button just competed with them.
 *
 * `/import/*` stays mounted (unlisted) because the Chrome helper extension hands off to that
 * path with `candidates` / `uploadedFile` query params; existing links must keep working.
 */
import { Suspense, lazy } from 'react'
import { Typography } from '@mui/joy'
import type { WebPlugin } from '../../plugin/types'
import { LibraryImportMenuAction, PrinterImportMenuAction } from './ImportMenuActions'
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
    { name: 'printers.print.menu', component: PrinterImportMenuAction }
  ],
  settingsPanel: RemoteImportsSettingsPanel
}
