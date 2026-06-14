process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { Printer } from '@printstream/shared'
import {
  buildRtspFfmpegInputArgs,
  buildRtspFfmpegStreamOutputArgs,
  buildRtspCameraUrls,
  clearPreferredRtspCameraUrlsForTests,
  createStreamFrameWatchdog,
  createFrameRateLimiter,
  shouldPauseCameraForFtpActivity,
  setPreferredRtspCameraUrlForTests
} from './camera.js'

const rtspPrinter: Printer = {
  id: 'printer-rtsp-1',
  name: 'RTSP Printer',
  host: 'printer.local',
  serial: 'SERIAL-RTSP-1',
  accessCode: 'secret code',
  model: 'X1C',
  currentPlateType: null,
  currentNozzleDiameters: [],
  position: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString()
}

afterEach(() => {
  clearPreferredRtspCameraUrlsForTests()
  mock.timers.reset()
})

test('source frame limiter emits at most 15 fps', () => {
  const times = [0, 20, 40, 67, 100, 120, 134, 201]
  let index = 0
  const limiter = createFrameRateLimiter({
    minIntervalMs: Math.round(1000 / 15),
    getNow: () => times[index++] ?? times[times.length - 1] ?? 0
  })

  assert.equal(limiter.shouldEmit(), true)
  assert.equal(limiter.shouldEmit(), false)
  assert.equal(limiter.shouldEmit(), false)
  assert.equal(limiter.shouldEmit(), true)
  assert.equal(limiter.shouldEmit(), false)
  assert.equal(limiter.shouldEmit(), false)
  assert.equal(limiter.shouldEmit(), true)
  assert.equal(limiter.shouldEmit(), true)
})

test('source frame limiter is disabled by default', () => {
  const limiter = createFrameRateLimiter()

  assert.equal(limiter.shouldEmit(), true)
  assert.equal(limiter.shouldEmit(), true)
  assert.equal(limiter.shouldEmit(), true)
})

test('buildRtspCameraUrls promotes the last working URL for the printer', () => {
  const baseline = buildRtspCameraUrls(rtspPrinter)
  assert.equal(baseline[0], 'rtsps://bblp:secret%20code@printer.local:322/streaming/live/1')

  setPreferredRtspCameraUrlForTests(rtspPrinter, 'rtsp://bblp:secret%20code@printer.local/streaming/live/1')
  const preferred = buildRtspCameraUrls(rtspPrinter)

  assert.equal(preferred[0], 'rtsp://bblp:secret%20code@printer.local/streaming/live/1')
  assert.deepEqual(new Set(preferred), new Set(baseline))
})

test('stream watchdog times out on startup and then on frame gaps', () => {
  mock.timers.enable({ apis: ['setTimeout'] })

  const timeouts: Array<{ reason: 'startup' | 'frame-gap'; timeoutMs: number }> = []
  const watchdog = createStreamFrameWatchdog({
    onTimeout: (event) => {
      timeouts.push(event)
    },
    startupTimeoutMs: 100,
    frameGapTimeoutMs: 50
  })

  mock.timers.tick(99)
  assert.equal(timeouts.length, 0)

  mock.timers.tick(1)
  assert.deepEqual(timeouts, [{ reason: 'startup', timeoutMs: 100 }])

  watchdog.noteFrame()
  mock.timers.tick(49)
  assert.equal(timeouts.length, 1)

  mock.timers.tick(1)
  assert.deepEqual(timeouts, [
    { reason: 'startup', timeoutMs: 100 },
    { reason: 'frame-gap', timeoutMs: 50 }
  ])

  watchdog.stop()
  mock.timers.tick(500)
  assert.equal(timeouts.length, 2)
})

test('RTSP ffmpeg input args enable low-latency camera startup', () => {
  assert.deepEqual(buildRtspFfmpegInputArgs('rtsps://example/stream'), [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-analyzeduration', '0',
    '-probesize', '32',
    '-i', 'rtsps://example/stream'
  ])
})

test('RTSP ffmpeg stream output regenerates monotonic timestamps from frame index', () => {
  assert.deepEqual(buildRtspFfmpegStreamOutputArgs(), [
    '-vsync', '0',
    '-vf', 'setpts=N/TB',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg'
  ])
})

test('FTP activity pause only applies to TLS camera models', () => {
  assert.equal(shouldPauseCameraForFtpActivity('P1S'), true)
  assert.equal(shouldPauseCameraForFtpActivity('A1'), true)
  assert.equal(shouldPauseCameraForFtpActivity('H2D'), false)
  assert.equal(shouldPauseCameraForFtpActivity('X1C'), false)
})