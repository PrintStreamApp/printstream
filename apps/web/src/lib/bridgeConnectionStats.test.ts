import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBridgeConnectionStatItems } from './bridgeConnectionStats.js'

test('buildBridgeConnectionStatItems reports a connected bridge with live counts', () => {
  assert.deepEqual(buildBridgeConnectionStatItems({
    connected: true,
    connectedAt: '2026-05-08T18:20:00.000Z',
    pendingRpcCount: 2,
    activeCameraWatchCount: 3,
    activePrinterFtpCount: 1
  }), [
    'Connection: Connected',
    'Pending RPCs: 2',
    'Camera watches: 3',
    'Active transfers: 1'
  ])
})

test('buildBridgeConnectionStatItems reports an offline bridge with zero activity', () => {
  assert.deepEqual(buildBridgeConnectionStatItems({
    connected: false,
    connectedAt: null,
    pendingRpcCount: 0,
    activeCameraWatchCount: 0,
    activePrinterFtpCount: 0
  }), [
    'Connection: Offline',
    'Pending RPCs: 0',
    'Camera watches: 0',
    'Active transfers: 0'
  ])
})