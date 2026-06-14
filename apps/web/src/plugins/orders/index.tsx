/* eslint-disable react-refresh/only-export-components -- plugin entry exports a lazy route intentionally */
/**
 * Orders plugin (web side).
 *
 * Adds an app-relative `/orders` navigation entry, mounted under a workspace
 * slug, plus nested detail routes for template management, order creation,
 * and per-print confirmation/manual completion.
 */
import { Suspense, lazy } from 'react'
import { Typography } from '@mui/joy'
import type { WebPlugin } from '../../plugin/types'

const OrdersView = lazy(async () => {
  const module = await import('./OrdersView')
  return { default: module.OrdersView }
})

function OrdersRoute() {
  return (
    <Suspense fallback={<Typography level="body-sm">Loading orders…</Typography>}>
      <OrdersView />
    </Suspense>
  )
}

export const ordersPlugin: WebPlugin = {
  name: 'orders',
  version: '0.1.0',
  description: 'Templated production orders that track required prints and confirmations.',
  routes: [
    {
      path: '/orders/*',
      navLabel: 'Orders',
      element: OrdersRoute
    }
  ]
}