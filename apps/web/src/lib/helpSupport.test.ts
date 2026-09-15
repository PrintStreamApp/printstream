import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveHelpSupportTransport } from './helpSupport'

test('self-hosted help stays on email until the cloud connection is active', () => {
  assert.deepEqual(resolveHelpSupportTransport(true, []), {
    inApp: false,
    base: '/api/plugins/cloud-connection/support'
  })
  assert.deepEqual(resolveHelpSupportTransport(true, ['cloud-connection']), {
    inApp: true,
    base: '/api/plugins/cloud-connection/support'
  })
  assert.deepEqual(resolveHelpSupportTransport(true, ['cloud-connection'], false), {
    inApp: false,
    base: '/api/plugins/cloud-connection/support'
  })
})

test('hosted help always uses its local support API', () => {
  assert.deepEqual(resolveHelpSupportTransport(false, []), {
    inApp: true,
    base: '/api/support'
  })
})
