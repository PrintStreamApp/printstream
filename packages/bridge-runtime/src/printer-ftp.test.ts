process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS,
  buildResumingDataConnectionOptions,
  resolvePrinterFtpTransportSettings
} from './printer-ftp.js'

function fakeControl(protocol: string | null, session: Buffer | null) {
  return {
    getProtocol: () => protocol,
    getSession: () => session ?? undefined
  } as Parameters<typeof buildResumingDataConnectionOptions>[1]
}

test('buildResumingDataConnectionOptions pins TLS 1.2 and carries the control session', () => {
  // H2-series vsftpd requires the data connection to resume the control
  // connection's TLS session (522 "session reuse required" otherwise), and a
  // session can only resume into a handshake of the same protocol version.
  const session = Buffer.from('control-session')
  const options = buildResumingDataConnectionOptions(
    { host: '192.168.2.50', port: 50078, rejectUnauthorized: false },
    fakeControl('TLSv1.2', session),
    undefined
  )
  assert.equal(options.minVersion, 'TLSv1.2')
  assert.equal(options.maxVersion, 'TLSv1.2')
  assert.equal(options.session, session)
  assert.equal(options.rejectUnauthorized, false)
})

test('buildResumingDataConnectionOptions uses the session-event ticket for TLS 1.3', () => {
  // TLS 1.3 delivers resumable sessions via post-handshake 'session' events;
  // getSession() is only meaningful for <= TLS 1.2.
  const staleHandshakeSession = Buffer.from('not-a-1.3-ticket')
  const ticket = Buffer.from('post-handshake-ticket')
  const options = buildResumingDataConnectionOptions(
    { host: '192.168.2.50', port: 50078 },
    fakeControl('TLSv1.3', staleHandshakeSession),
    ticket
  )
  assert.equal(options.minVersion, 'TLSv1.3')
  assert.equal(options.maxVersion, 'TLSv1.3')
  assert.equal(options.session, ticket)
})

test('buildResumingDataConnectionOptions degrades gracefully without protocol or session', () => {
  const options = buildResumingDataConnectionOptions(
    { host: '192.168.2.50', port: 50078 },
    fakeControl(null, null),
    undefined
  )
  assert.equal(options.minVersion, undefined)
  assert.equal(options.maxVersion, undefined)
  assert.equal(options.session, undefined)
})

test('resolvePrinterFtpTransportSettings returns the production defaults when omitted', () => {
  assert.deepEqual(resolvePrinterFtpTransportSettings(), DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS)
})

test('resolvePrinterFtpTransportSettings applies explicit overrides and rejects invalid integers', () => {
  assert.deepEqual(
    resolvePrinterFtpTransportSettings({
      socketTimeoutMs: 90_000,
      uploadReadHighWaterMarkBytes: 512 * 1024,
      socketNoDelay: true,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: -25
    }),
    {
      socketTimeoutMs: 90_000,
      uploadReadHighWaterMarkBytes: 512 * 1024,
      socketNoDelay: true,
      socketKeepAlive: true,
      socketKeepAliveInitialDelayMs: DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS.socketKeepAliveInitialDelayMs
    }
  )
})

test('resolvePrinterFtpTransportSettings falls back for non-positive transport sizes', () => {
  assert.deepEqual(
    resolvePrinterFtpTransportSettings({
      socketTimeoutMs: 0,
      uploadReadHighWaterMarkBytes: 0
    }),
    DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS
  )
})