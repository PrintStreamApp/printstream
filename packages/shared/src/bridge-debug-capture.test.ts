import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bridgeDebugCaptureFrameSchema,
  bridgeDebugCaptureReadResultSchema,
  bridgeDebugCaptureStatusSchema,
  bridgeDebugCaptureStatusMessageSchema,
  inactiveBridgeDebugCaptureStatus
} from './index.js'
import { wsEventSchema } from './ws-events.js'

test('inactive capture status satisfies the status schema', () => {
  assert.doesNotThrow(() => bridgeDebugCaptureStatusSchema.parse(inactiveBridgeDebugCaptureStatus))
  assert.equal(inactiveBridgeDebugCaptureStatus.active, false)
  assert.equal(inactiveBridgeDebugCaptureStatus.hasCapture, false)
})

test('a capture frame round-trips through its schema', () => {
  const frame = {
    seq: 3,
    at: new Date(0).toISOString(),
    kind: 'mqtt' as const,
    direction: 'rx' as const,
    printerId: 'printer-1',
    printerName: 'Aviato',
    topic: 'device/SERIAL/report',
    payload: { print: { gcode_state: 'RUNNING' } }
  }
  assert.deepEqual(bridgeDebugCaptureFrameSchema.parse(frame), frame)
})

test('the read result preserves frames and window metadata', () => {
  const result = {
    startedAt: new Date(0).toISOString(),
    stoppedAt: new Date(1000).toISOString(),
    frames: [{ seq: 0, at: new Date(0).toISOString(), kind: 'connection' as const, summary: 'connect' }],
    droppedFrames: 2,
    truncated: true
  }
  assert.deepEqual(bridgeDebugCaptureReadResultSchema.parse(result), result)
})

test('the status message and WS event accept a status payload', () => {
  const status = { ...inactiveBridgeDebugCaptureStatus, active: true, startedAt: new Date(0).toISOString(), frameCount: 5 }
  assert.doesNotThrow(() => bridgeDebugCaptureStatusMessageSchema.parse({ type: 'bridge.debug.capture.status', status }))
  const event = wsEventSchema.parse({ type: 'bridge.debug.capture', bridgeId: 'bridge-1', status })
  assert.equal(event.type, 'bridge.debug.capture')
})
