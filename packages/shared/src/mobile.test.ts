import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PRINTSTREAM_MOBILE_PROTOCOL_VERSION,
  mobileCanonicalOriginSchema,
  mobileDiscoveryResponseSchema
} from './mobile.js'

test('mobile discovery accepts a bounded canonical server origin', () => {
  assert.deepEqual(mobileDiscoveryResponseSchema.parse({
    product: 'printstream',
    protocolVersion: PRINTSTREAM_MOBILE_PROTOCOL_VERSION,
    canonicalOrigin: 'https://printstream.app/',
    deployment: 'cloud',
    serverVersion: '1.0.6',
    nativeNotifications: { transport: 'unavailable' }
  }), {
    product: 'printstream',
    protocolVersion: 1,
    canonicalOrigin: 'https://printstream.app/',
    deployment: 'cloud',
    serverVersion: '1.0.6',
    nativeNotifications: { transport: 'unavailable' }
  })
})

test('mobile canonical origins reject credentials and routing suffixes', () => {
  for (const value of [
    'https://user:secret@printstream.app/',
    'https://printstream.app/workspaces/default',
    'https://printstream.app/?source=app',
    'https://printstream.app/#app',
    'file:///tmp/printstream'
  ]) {
    assert.equal(mobileCanonicalOriginSchema.safeParse(value).success, false, value)
  }
})
