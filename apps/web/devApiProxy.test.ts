import assert from 'node:assert/strict'
import test from 'node:test'
import { devApiProxyHeaders, isDevApiRequest } from './devApiProxy.js'

test('the dev HTTP proxy owns API, mobile discovery and public news routes', () => {
  assert.equal(isDevApiRequest('/api'), true)
  assert.equal(isDevApiRequest('/api/printers?limit=10'), true)
  assert.equal(isDevApiRequest('/.well-known/printstream-mobile.json'), true)
  assert.equal(isDevApiRequest('/.well-known/printstream-mobile.json?cache=off'), true)
  assert.equal(isDevApiRequest('/.well-known/other.json'), false)
  assert.equal(isDevApiRequest('/workspaces'), false)
  assert.equal(isDevApiRequest('/announcements.json'), true)
  assert.equal(isDevApiRequest('/announcements.json?cache=off'), true)
  assert.equal(isDevApiRequest('/announcements'), false)
})

test('mobile discovery preserves the Vite origin while ordinary API traffic targets the API port', () => {
  const browserHeaders = { host: 'localhost:5173', connection: 'keep-alive' }

  assert.deepEqual(
    devApiProxyHeaders('/.well-known/printstream-mobile.json', browserHeaders, '4000'),
    { host: 'localhost:5173' }
  )
  assert.deepEqual(
    devApiProxyHeaders('/api/health', browserHeaders, '4000'),
    { host: 'localhost:4000' }
  )
})
