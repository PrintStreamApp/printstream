import assert from 'node:assert/strict'
import test from 'node:test'
import { mobileNotificationTransport, registerMobileNotificationTransport, resetMobileNotificationTransportForTests } from './mobile-notification-capability.js'

test('discovery reports only a live sender and rejects conflicting transports', () => {
  resetMobileNotificationTransportForTests()
  assert.equal(mobileNotificationTransport(), 'unavailable')
  const stop = registerMobileNotificationTransport('direct')
  assert.equal(mobileNotificationTransport(), 'direct')
  assert.throws(() => registerMobileNotificationTransport('relay'), /already registered/)
  const stopSecond = registerMobileNotificationTransport('direct')
  stop()
  assert.equal(mobileNotificationTransport(), 'direct')
  stopSecond()
  assert.equal(mobileNotificationTransport(), 'unavailable')
})
