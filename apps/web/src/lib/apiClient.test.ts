import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apiFetch } from './apiClient.js'

test('apiFetch includes credentials so cookie-backed auth works with absolute API origins', async () => {
  const originalFetch = globalThis.fetch
  let capturedInit: RequestInit | undefined

  Object.defineProperty(globalThis, 'fetch', {
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    },
    configurable: true,
    writable: true
  })

  try {
    assert.deepEqual(await apiFetch<{ ok: boolean }>('/api/test'), { ok: true })
    assert.equal(capturedInit?.credentials, 'include')
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      value: originalFetch,
      configurable: true,
      writable: true
    })
  }
})