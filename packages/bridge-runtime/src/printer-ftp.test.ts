process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PRINTER_FTP_TRANSPORT_SETTINGS,
  resolvePrinterFtpTransportSettings
} from './printer-ftp.js'

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