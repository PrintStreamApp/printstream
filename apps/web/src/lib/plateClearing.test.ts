import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchPlateClearingStateFromUrl } from './plateClearing.js'

const TEST_URL = 'http://example.test/api/plugins/plate-clearing/state'

test('fetchPlateClearingState returns an empty state when the plugin route is missing', async () => {
  const originalFetch = globalThis.fetch

  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response(null, { status: 404 }),
    configurable: true,
    writable: true
  })

  try {
    assert.deepEqual(await fetchPlateClearingStateFromUrl(TEST_URL), { printers: [] })
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true
    })
  }
})

test('fetchPlateClearingState returns an empty state when the plugin is disabled', async () => {
  const originalFetch = globalThis.fetch

  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response(JSON.stringify({ error: 'Plugin disabled: plate-clearing' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    }),
    configurable: true,
    writable: true
  })

  try {
    assert.deepEqual(await fetchPlateClearingStateFromUrl(TEST_URL), { printers: [] })
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true
    })
  }
})

test('fetchPlateClearingState still throws for other server failures', async () => {
  const originalFetch = globalThis.fetch

  Object.defineProperty(globalThis, 'fetch', {
    value: async () => new Response(JSON.stringify({ error: 'something else' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    }),
    configurable: true,
    writable: true
  })

  try {
    await assert.rejects(() => fetchPlateClearingStateFromUrl(TEST_URL), /something else/)
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true
    })
  }
})