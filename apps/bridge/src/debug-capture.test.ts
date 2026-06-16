process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  getCaptureStatus,
  isCaptureActive,
  readCapture,
  recordCaptureFrame,
  startCapture,
  stopCapture
} from './debug-capture.js'

test('records frames only while a capture is active', () => {
  startCapture()
  assert.equal(isCaptureActive(), true)

  recordCaptureFrame({ kind: 'mqtt', direction: 'tx', printerId: 'p1', topic: 't', payload: { a: 1 } })
  recordCaptureFrame({ kind: 'connection', printerId: 'p1', summary: 'connect' })
  assert.equal(getCaptureStatus().frameCount, 2)

  const stopped = stopCapture('manual')
  assert.equal(stopped.active, false)
  assert.equal(stopped.hasCapture, true)

  // Frames recorded after stop are ignored.
  recordCaptureFrame({ kind: 'mqtt', direction: 'rx', printerId: 'p1', payload: { b: 2 } })
  assert.equal(getCaptureStatus().frameCount, 2)

  const capture = readCapture()
  assert.equal(capture.frames.length, 2)
  assert.equal(capture.frames[0]?.seq, 0)
  assert.equal(capture.frames[1]?.seq, 1)
  assert.deepEqual(capture.frames[0]?.payload, { a: 1 })
})

test('drops oldest frames past the frame cap', () => {
  startCapture({ maxFrames: 3 })
  for (let index = 0; index < 5; index += 1) {
    recordCaptureFrame({ kind: 'mqtt', direction: 'tx', printerId: 'p1', payload: { index } })
  }
  const status = getCaptureStatus()
  assert.equal(status.frameCount, 3)
  assert.equal(status.droppedFrames, 2)
  // The ring keeps the most recent frames.
  const frames = readCapture().frames
  assert.deepEqual(frames.map((frame) => (frame.payload as { index: number }).index), [2, 3, 4])
  stopCapture()
})

test('marks the capture truncated and stops it at the byte ceiling', () => {
  startCapture({ maxBytes: 250 })
  for (let index = 0; index < 50; index += 1) {
    recordCaptureFrame({ kind: 'mqtt', direction: 'tx', printerId: 'printer', payload: { padding: 'xxxxxxxxxx', index } })
  }
  const status = getCaptureStatus()
  assert.equal(status.truncated, true)
  assert.equal(status.active, false, 'hitting the byte ceiling stops the capture')
  assert.ok(status.frameCount >= 1 && status.frameCount < 50)
})

test('auto-stops at the duration cap', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    startCapture({ maxDurationMs: 1_000 })
    assert.equal(isCaptureActive(), true)
    mock.timers.tick(1_001)
    assert.equal(isCaptureActive(), false)
  } finally {
    mock.timers.reset()
    stopCapture()
  }
})
