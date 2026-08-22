/**
 * The freshness contract of the filament caches: reading a spool subscribes you to its
 * changes. Regression cover for slot pickers that named the spool a user had already
 * taken out, because the WS sync was mounted only by the Filament page.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { wsClient } from '../../lib/wsClient'
import { useSpoolsQuery } from './api'
import { SPOOLS_QUERY_KEY } from './queryKeys'

let dom: JSDOM

before(() => {
  dom = installJsdomGlobals({ url: 'http://localhost/library' })
  Object.assign(globalThis, {
    fetch: async () =>
      new Response(JSON.stringify({ spools: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
  })
})

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

/** Captures the WS listeners a render attaches, without opening a real socket. */
function stubWsClient() {
  const jsonListeners: Array<(data: unknown) => void> = []
  const original = {
    onJson: wsClient.onJson.bind(wsClient),
    start: wsClient.start.bind(wsClient),
    stop: wsClient.stop.bind(wsClient)
  }

  wsClient.onJson = ((listener: (data: unknown) => void) => {
    jsonListeners.push(listener)
    return () => {
      const index = jsonListeners.indexOf(listener)
      if (index >= 0) jsonListeners.splice(index, 1)
    }
  }) as typeof wsClient.onJson
  wsClient.start = (() => {}) as typeof wsClient.start
  wsClient.stop = (() => {}) as typeof wsClient.stop

  return {
    jsonListeners,
    restore() {
      wsClient.onJson = original.onJson
      wsClient.start = original.start
      wsClient.stop = original.stop
    }
  }
}

/** Records which query keys were invalidated, while still invalidating for real. */
function recordInvalidations(queryClient: QueryClient): string[][] {
  const keys: string[][] = []
  const original = queryClient.invalidateQueries.bind(queryClient)
  queryClient.invalidateQueries = ((filters, options) => {
    if (Array.isArray(filters?.queryKey)) keys.push(filters.queryKey.map(String))
    return original(filters, options)
  }) as typeof queryClient.invalidateQueries
  return keys
}

const SPOOLS_CHANGED = { type: 'plugin.event', pluginName: 'filament-manager', event: { kind: 'spools.changed' } }

test('reading spools anywhere subscribes to inventory changes', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const invalidated = recordInvalidations(queryClient)
  const ws = stubWsClient()

  // Deliberately NOT the Filament view: a slot picker in a print dialog reads spools
  // through this same hook, and used to get no live updates at all.
  function SlotPickerHarness() {
    useSpoolsQuery()
    return null
  }

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <SlotPickerHarness />
      </QueryClientProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(ws.jsonListeners.length, 1, 'expected the spool reader to attach a WS listener')

    ws.jsonListeners[0]?.(SPOOLS_CHANGED)
    assert.ok(
      invalidated.some((key) => key.join('/') === SPOOLS_QUERY_KEY.join('/')),
      'a spools.changed event should invalidate the spool list'
    )
  } finally {
    ws.restore()
  }
})

test('several readers share one listener', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const ws = stubWsClient()

  // An open print dialog mounts this hook once per slot row; a listener per row would
  // re-parse every WS frame, printer status included, once per row.
  function SlotRow() {
    useSpoolsQuery()
    return null
  }

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <SlotRow />
        <SlotRow />
        <SlotRow />
      </QueryClientProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(ws.jsonListeners.length, 1)
  } finally {
    ws.restore()
  }
})

test('a disabled plugin neither fetches nor listens', async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  const ws = stubWsClient()

  function DisabledHarness() {
    useSpoolsQuery(false)
    return null
  }

  try {
    render(
      <QueryClientProvider client={queryClient}>
        <DisabledHarness />
      </QueryClientProvider>
    )
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(ws.jsonListeners.length, 0)
  } finally {
    ws.restore()
  }
})
