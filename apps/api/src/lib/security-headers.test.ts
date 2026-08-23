import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSecurityHeaderOptions, shouldSendStrictTransportSecurity } from './security-headers.js'

test('HSTS is sent only in production, where TLS is actually terminated', () => {
  assert.equal(shouldSendStrictTransportSecurity('production'), true)
})

test('HSTS is never sent over the plain-HTTP dev and test servers', () => {
  // The bug this pins: helmet's default sent HSTS on http://localhost. Browsers honour the
  // header per hostname, so one dev response pinned localhost to https for a year and later
  // requests died at the transport with a certificate error: seen as intermittent
  // ERR_PROXY_CERTIFICATE_INVALID on image loads that were fine when fetched directly.
  for (const nodeEnv of ['development', 'test']) {
    assert.equal(shouldSendStrictTransportSecurity(nodeEnv), false, `${nodeEnv} must not send HSTS`)
  }
})

test('the other two helmet defaults stay off, whatever the environment', () => {
  for (const nodeEnv of ['development', 'production']) {
    const options = buildSecurityHeaderOptions(nodeEnv)
    // The camera proxy serves MJPEG / blob: frames the strict default would block...
    assert.equal(options.crossOriginResourcePolicy, false)
    // ...and our own CSP is built separately, so helmet must not emit a second one.
    assert.equal(options.contentSecurityPolicy, false)
  }
})
