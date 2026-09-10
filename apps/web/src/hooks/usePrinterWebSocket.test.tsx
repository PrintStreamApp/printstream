import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { usePrinterWebSocket } from './usePrinterWebSocket'
import { wsClient } from '../lib/wsClient'

let dom: JSDOM

before(() => {
  dom = installJsdomGlobals({ url: 'http://localhost/printers' })
})

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('websocket reconnect refreshes jobs and dispatch queries after the initial socket open', async () => {
  const queryClient = new QueryClient()
  const invalidatedKeys: string[] = []
  const openListeners: Array<() => void> = []
  const jsonListeners: Array<(data: unknown) => void> = []

  const originalInvalidateQueries = queryClient.invalidateQueries.bind(queryClient)
  queryClient.invalidateQueries = ((filters, options) => {
    const key = Array.isArray(filters?.queryKey) ? String(filters.queryKey[0]) : 'unknown'
    invalidatedKeys.push(key)
    return originalInvalidateQueries(filters, options)
  }) as typeof queryClient.invalidateQueries

  const originalOnOpen = wsClient.onOpen.bind(wsClient)
  const originalOnJson = wsClient.onJson.bind(wsClient)
  const originalStart = wsClient.start.bind(wsClient)
  const originalStop = wsClient.stop.bind(wsClient)

  wsClient.onOpen = ((listener: () => void) => {
    openListeners.push(listener)
    return () => {
      const index = openListeners.indexOf(listener)
      if (index >= 0) openListeners.splice(index, 1)
    }
  }) as typeof wsClient.onOpen
  wsClient.onJson = ((listener: (data: unknown) => void) => {
    jsonListeners.push(listener)
    return () => {
      const index = jsonListeners.indexOf(listener)
      if (index >= 0) jsonListeners.splice(index, 1)
    }
  }) as typeof wsClient.onJson
  wsClient.start = (() => {}) as typeof wsClient.start
  wsClient.stop = (() => {}) as typeof wsClient.stop

  function Harness() {
    usePrinterWebSocket(true, 'workspace:test')
    return null
  }

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(openListeners.length, 1)

    openListeners[0]?.()
    assert.deepEqual(invalidatedKeys, [])

    openListeners[0]?.()
    assert.deepEqual(invalidatedKeys, ['jobs', 'job-history', 'print-dispatch'])
  } finally {
    queryClient.invalidateQueries = originalInvalidateQueries
    wsClient.onOpen = originalOnOpen
    wsClient.onJson = originalOnJson
    wsClient.start = originalStart
    wsClient.stop = originalStop
  }
})