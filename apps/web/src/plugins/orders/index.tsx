/**
 * Orders plugin (web side).
 *
 * Adds an app-relative `/orders` navigation entry, mounted under a workspace
 * slug, plus nested detail routes for template management, order creation,
 * and per-print confirmation/manual completion. Eager-loaded with the app shell.
 */
import type { WebPlugin } from '../../plugin/types'
import { OrdersView } from './OrdersView'

export const ordersPlugin: WebPlugin = {
  name: 'orders',
  version: '0.1.0',
  description: 'Templated production orders that track required prints and confirmations.',
  routes: [
    {
      path: '/orders/*',
      navLabel: 'Orders',
      element: OrdersView
    }
  ]
}
