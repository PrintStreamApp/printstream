import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inactiveBridgeDebugCaptureStatus } from '@printstream/shared'
import {
  clearBridgeDebugCaptureStatus,
  getBridgeDebugCaptureStatus,
  setBridgeDebugCaptureStatus
} from './bridge-debug-capture.js'

test('defaults to an inactive status for unknown bridges', () => {
  assert.deepEqual(getBridgeDebugCaptureStatus('missing-bridge'), inactiveBridgeDebugCaptureStatus)
})

test('stores and clears a bridge capture status', () => {
  const status = {
    active: true,
    startedAt: new Date(0).toISOString(),
    stoppedAt: null,
    frameCount: 12,
    bytes: 2048,
    droppedFrames: 0,
    truncated: false,
    hasCapture: true
  }
  setBridgeDebugCaptureStatus('bridge-1', status)
  assert.deepEqual(getBridgeDebugCaptureStatus('bridge-1'), status)

  clearBridgeDebugCaptureStatus('bridge-1')
  assert.deepEqual(getBridgeDebugCaptureStatus('bridge-1'), inactiveBridgeDebugCaptureStatus)
})
