import assert from 'node:assert/strict'
import test from 'node:test'
import { createMobileConnectionNameReader } from './mobile-connection-name.js'

test('unlicensed connections never contact the cloud', async () => {
  const read = createMobileConnectionNameReader({
    key: async () => null,
    installationId: async () => { throw new Error('Unexpected identity lookup') },
    origin: () => { throw new Error('Unexpected origin lookup') },
    fetch: async () => { throw new Error('Unexpected request') },
    now: () => 0
  })
  assert.deepEqual(await read(), { name: null })
})

test('names are credential-scoped, coalesced and refreshed, without leaking extra fields', async () => {
  let key = 'first-key'
  let now = 0
  let calls = 0
  const read = createMobileConnectionNameReader({
    key: async () => key,
    installationId: async () => 'installation',
    origin: () => 'https://issuer.example',
    fetch: async (url, options) => {
      calls++
      assert.equal(url, 'https://issuer.example/api/license/refresh/name')
      assert.equal(options?.redirect, 'error')
      assert.deepEqual(JSON.parse(String(options?.body)), { key, installationId: 'installation' })
      return Response.json({ name: ' Workshop ', email: 'private@example.com', key })
    },
    now: () => now
  })
  assert.deepEqual(await Promise.all([read(), read()]), [{ name: 'Workshop' }, { name: 'Workshop' }])
  assert.equal(calls, 1)
  now = 300_001
  await read()
  assert.equal(calls, 2)
  key = 'replacement-key'
  await read()
  assert.equal(calls, 3)
})

test('offline responses reject without clearing names or leaking secrets', async () => {
  let calls = 0
  const read = createMobileConnectionNameReader({
    key: async () => 'secret',
    installationId: async () => 'installation',
    origin: () => 'https://issuer.example',
    fetch: async () => { calls++; throw new Error('secret') },
    now: () => 0
  })
  await assert.rejects(read(), { message: 'License display name lookup unavailable.' })
  await assert.rejects(read(), { message: 'License display name lookup unavailable.' })
  assert.equal(calls, 1)
})

test('unnamed licences clear the label, but malformed and failed responses do not', async () => {
  for (const [response, expected] of [
    [Response.json({ name: null }), { name: null }],
    [Response.json({ name: 'x'.repeat(121) }), null],
    [Response.json({ owner: 'Not a server name' }), null],
    [new Response('upstream secret', { status: 503 }), null]
  ] as const) {
    const read = createMobileConnectionNameReader({
      key: async () => 'secret',
      installationId: async () => 'installation',
      origin: () => 'https://issuer.example',
      fetch: async () => response,
      now: () => 0
    })
    if (expected) assert.deepEqual(await read(), expected)
    else await assert.rejects(read(), { message: 'License display name lookup unavailable.' })
  }
})
