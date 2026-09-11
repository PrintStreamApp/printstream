/**
 * Keeps the orders cache live when a persisted print job changes.
 *
 * The API reconciles started order prints against PrintJob history while reading
 * the orders list. A job finishing therefore has to stale that list even though
 * the orders tables have not changed yet; the refetch performs the reconciliation
 * and exposes the confirmation action without requiring a page reload.
 */
import type { QueryKey } from '@tanstack/react-query'
import type { WsEvent } from '@printstream/shared'
import { createWsQuerySync } from '../../lib/wsQuerySync'

// Keep job-finish refreshes scoped to the list. The broader `['orders']` prefix also owns
// templates and picker data, which do not change when a print completes.
export const ORDERS_LIST_QUERY_KEY = ['orders', 'list'] as const

export function selectOrderPrintCompletionQueryKeys(event: WsEvent): readonly QueryKey[] | null {
  return event.type === 'resource.changed' && event.resource === 'jobs'
    ? [ORDERS_LIST_QUERY_KEY]
    : null
}

export const useOrderPrintCompletionSync = createWsQuerySync(selectOrderPrintCompletionQueryKeys)
