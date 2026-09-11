import assert from 'node:assert/strict'
import test from 'node:test'
import type { WsEvent } from '@printstream/shared'
import {
  ORDERS_LIST_QUERY_KEY,
  selectOrderPrintCompletionQueryKeys
} from './useOrderPrintCompletionSync'

test('a persisted print-job change invalidates orders so finished prints become confirmable', () => {
  assert.deepEqual(
    selectOrderPrintCompletionQueryKeys({
      type: 'resource.changed',
      resource: 'jobs'
    } satisfies WsEvent),
    [ORDERS_LIST_QUERY_KEY]
  )
})

test('unrelated resource changes do not refetch orders', () => {
  assert.equal(
    selectOrderPrintCompletionQueryKeys({
      type: 'resource.changed',
      resource: 'library'
    } satisfies WsEvent),
    null
  )
})
