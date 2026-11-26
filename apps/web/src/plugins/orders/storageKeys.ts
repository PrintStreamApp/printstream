/**
 * Browser storage keys owned by the orders plugin (CONF-7, D-105; the registry is
 * `lib/browserStorageKeys.ts`). Its library pickers use core's library keys.
 */
import { defineStorageKey } from '../../lib/browserStorageKeys'

const owner = 'plugin:orders'

/** A device preference for one of the orders lists. */
function preference(key: string) {
  return defineStorageKey({ key, storage: 'local', kind: 'preference', owner })
}

export const activeOrdersSortKey = preference('printstream.orders.active.sort')
export const activeOrdersSortDirKey = preference('printstream.orders.active.sortDir')
export const activeOrdersPageSizeKey = preference('printstream.orders.active.pageSize')
export const completedOrdersSortKey = preference('printstream.orders.completed.sort')
export const completedOrdersSortDirKey = preference('printstream.orders.completed.sortDir')
export const completedOrdersPageSizeKey = preference('printstream.orders.completed.pageSize')
export const orderTemplatesPageSizeKey = preference('printstream.orders.templates.pageSize')
