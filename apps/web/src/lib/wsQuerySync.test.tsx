/**
 * The subscribe/unsubscribe bookkeeping behind every WS-backed query cache.
 *
 * One shared listener serves every mounted consumer, so the reference count that
 * decides when to attach it is the whole contract: get it stranded and the caches
 * it feeds stop refreshing for the rest of the tab's life, with nothing logged.
 */
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { wsClient } from './wsClient'
import { createWsQuerySync } from './wsQuerySync'

let dom: JSDOM

before(() => {
  dom = installJsdomGlobals({ url: 'http://localhost/' })
})

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

/** Captures attached listeners, and can make the socket refuse to start once. */
function stubWsClient() {
  const jsonListeners: Array<(data: unknown) => void> = []
  const original = {
    onJson: wsClient.onJson.bind(wsClient),
    start: wsClient.start.bind(wsClient),
    stop: wsClient.stop.bind(wsClient)
  }
  let failNextStart = false

  wsClient.onJson = ((listener: (data: unknown) => void) => {
    jsonListeners.push(listener)
    return () => {
      const index = jsonListeners.indexOf(listener)
      if (index >= 0) jsonListeners.splice(index, 1)
    }
  }) as typeof wsClient.onJson
  wsClient.start = (() => {
    if (!failNextStart) return
    failNextStart = false
    // What the real `start()` does on a malformed API base URL or a connect the
    // page's CSP blocks: `new WebSocket(...)` throws.
    throw new SyntaxError('WebSocket construction failed')
  }) as typeof wsClient.start
  wsClient.stop = (() => {}) as typeof wsClient.stop

  return {
    jsonListeners,
    failNextStart() { failNextStart = true },
    restore() {
      wsClient.onJson = original.onJson
      wsClient.start = original.start
      wsClient.stop = original.stop
    }
  }
}

function renderSync(useSync: (enabled?: boolean) => void) {
  function Harness() {
    useSync()
    return null
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>
  )
}

test('a failed attach does not strand the subscriber count', () => {
  // The regression this pins: the count was incremented BEFORE the attach, and
  // React only stores an effect's cleanup if the effect body returns. So a throw
  // left the count at 1 with no listener attached, every later mount pushed it to
  // 2, 3, ..., and the "first subscriber" branch never came round again. The
  // caches this syncs silently stopped being invalidated for the tab's lifetime.
  const ws = stubWsClient()
  const useSync = createWsQuerySync(() => [['spools']])
  try {
    ws.failNextStart()
    assert.throws(() => renderSync(useSync))
    cleanup()

    renderSync(useSync)
    assert.equal(ws.jsonListeners.length, 1, 'the next mount retries the attach')
  } finally {
    ws.restore()
  }
})

test('one listener serves several consumers and is dropped with the last of them', () => {
  const ws = stubWsClient()
  const useSync = createWsQuerySync(() => [['spools']])
  try {
    const first = renderSync(useSync)
    const second = renderSync(useSync)
    assert.equal(ws.jsonListeners.length, 1, 'the second consumer reuses the open listener')

    first.unmount()
    assert.equal(ws.jsonListeners.length, 1, 'still listening while a consumer remains')

    second.unmount()
    assert.equal(ws.jsonListeners.length, 0, 'detached with the last consumer')
  } finally {
    ws.restore()
  }
})
