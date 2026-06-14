import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasLivePrinterControlConnection } from './printer-connection-state.js'

test('offline printer state overrides a stale mqtt connected flag', () => {
  assert.equal(hasLivePrinterControlConnection({ online: false }, true), false)
})

test('live printer state requires both mqtt connectivity and online status', () => {
  assert.equal(hasLivePrinterControlConnection({ online: true }, true), true)
  assert.equal(hasLivePrinterControlConnection({ online: true }, false), false)
  assert.equal(hasLivePrinterControlConnection(undefined, true), false)
})