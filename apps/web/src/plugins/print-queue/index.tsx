/**
 * Print-queue plugin (web side).
 *
 * Contributes the print-queue section at the top of the core Jobs page (the
 * `jobs.sections` slot): a shared, reorderable print backlog whose items show
 * a live eligibility badge (matched against each printer's loaded AMS material) and
 * are dispatched on demand. The section is eager-loaded with the app shell — this is
 * core app functionality, not a heavy/optional surface, so it should be ready on
 * first paint. The legacy top-level "/queue" route stays registered (unlisted) as a
 * redirect to /jobs so old bookmarks and landing-page preferences keep working.
 */
import type { WebPlugin } from '../../plugin/types'
import { QueueRedirect } from './QueueRedirect'
import { QueueSection } from './QueueSection'
import { SettingsPanel } from './SettingsPanel'
import { LibraryAddToQueueAction } from './LibraryAddToQueueAction'
import { LibraryAddToQueueHost } from './LibraryAddToQueueHost'
import { OrdersAddToQueueAction } from './OrdersAddToQueueAction'

export const printQueuePlugin: WebPlugin = {
  name: 'print-queue',
  version: '0.1.0',
  description: 'A shared, reorderable print backlog on the Jobs page that matches queued jobs to printers by loaded AMS material.',
  routes: [
    {
      path: '/queue/*',
      element: QueueRedirect
    }
  ],
  slots: [
    // The queue itself renders as the top section of the core Jobs page.
    { name: 'jobs.sections', component: QueueSection },
    // Negative order keeps "Add to queue" first among library.fileActions plugins so it
    // sits immediately after the core "Print" item (which renders before the slot) in
    // every library kebab/context menu, ahead of model-studio's Preview / Open actions.
    { name: 'library.fileActions', component: LibraryAddToQueueAction, order: -10 },
    { name: 'library.overlays', component: LibraryAddToQueueHost },
    // Order items get an "Add to queue" action that links the queued print to the order;
    // the overlay host (shared with the library) renders the resulting flow.
    { name: 'orders.itemActions', component: OrdersAddToQueueAction },
    { name: 'orders.overlays', component: LibraryAddToQueueHost }
  ],
  settingsPanel: SettingsPanel
}
