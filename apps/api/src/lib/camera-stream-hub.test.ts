process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Printer } from '@printstream/shared'
import { CameraStreamHub } from './camera-stream-hub.js'

/**
 * Pass-through pacer so hub tests exercise fan-out/reconnect behaviour without
 * the production playout buffer's added latency (covered in camera-frame-pacer.test.ts).
 */
const passthroughPacer = async function* (source: AsyncIterable<Buffer>): AsyncGenerator<Buffer, void, void> {
  yield* source
}

afterEach(() => {
  mock.restoreAll()
})

// Generous failsafe timeout: the loop resolves the instant the predicate is true, so a happy run
// stays fast — the ceiling only exists to fail a genuinely stuck test, and must tolerate a busy CPU.
async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for test condition')
    }
    await delay(5)
  }
}

test('camera stream hub forwards every source frame without downstream throttling', async () => {
  const printer: Printer = {
    id: 'printer-1',
    name: 'Printer 1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }
  const frame1 = Buffer.from('frame-1')
  const frame2 = Buffer.from('frame-2')
  const frame3 = Buffer.from('frame-3')

  const hub = new CameraStreamHub({
    gracePeriodMs: 0,
    framePacer: passthroughPacer,
    getPrinter: () => printer,
    readFrames: async function* (_printer, signal): AsyncGenerator<Buffer, void, void> {
      yield frame1
      await delay(5)
      yield frame2
      await delay(5)
      yield frame3

      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })

  const delivered: Buffer[] = []
  const unsubscribe = hub.subscribe(printer.id, (frame) => {
    delivered.push(frame)
  })

  await waitForCondition(() => delivered.length === 3)
  unsubscribe()
  await delay(5)

  assert.deepEqual(delivered, [frame1, frame2, frame3])
})

test('camera stream hub exposes the latest frame during the grace period after unsubscribe', async () => {
  const printer: Printer = {
    id: 'printer-1',
    name: 'Printer 1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }
  const frame = Buffer.from('frame-1')

  const hub = new CameraStreamHub({
    gracePeriodMs: 20,
    framePacer: passthroughPacer,
    getPrinter: () => printer,
    readFrames: async function* (_printer, signal): AsyncGenerator<Buffer, void, void> {
      yield frame
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })

  const unsubscribe = hub.subscribe(printer.id, () => undefined)
  await delay(5)
  unsubscribe()

  assert.deepEqual(hub.getLatestFrame(printer.id), frame)
  assert.equal(hub.getLatestFrame(printer.id, { requireListeners: true }), null)

  await delay(30)
  assert.equal(hub.getLatestFrame(printer.id), null)
})

test('camera stream hub can reject stale latest frames', async () => {
  const printer: Printer = {
    id: 'printer-1',
    name: 'Printer 1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }
  let now = 1_000

  const hub = new CameraStreamHub({
    gracePeriodMs: 0,
    framePacer: passthroughPacer,
    getNow: () => now,
    getPrinter: () => printer,
    readFrames: async function* (_printer, signal): AsyncGenerator<Buffer, void, void> {
      yield Buffer.from('frame-1')
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })

  const unsubscribe = hub.subscribe(printer.id, () => undefined)
  await delay(5)

  assert.deepEqual(hub.getLatestFrame(printer.id, { maxAgeMs: 2_500, requireListeners: true }), Buffer.from('frame-1'))

  now = 4_000

  assert.equal(hub.getLatestFrame(printer.id, { maxAgeMs: 2_500, requireListeners: true }), null)
  unsubscribe()
})

test('camera stream hub logs when a subscriber reuses the grace-period stream', async () => {
  const printer: Printer = {
    id: 'printer-1',
    name: 'Printer 1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }

  const debug = mock.method(console, 'debug', () => undefined)
  const hub = new CameraStreamHub({
    gracePeriodMs: 1_000,
    framePacer: passthroughPacer,
    getNow: (() => {
      let now = 0
      return () => now++
    })(),
    getPrinter: () => printer,
    readFrames: async function* (_printer, signal): AsyncGenerator<Buffer, void, void> {
      yield Buffer.from('frame-1')
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })

  const unsubscribe = hub.subscribe(printer.id, () => undefined)
  await delay(5)
  unsubscribe()

  hub.subscribe(printer.id, () => undefined)

  assert.equal(
    debug.mock.calls.some((call) => call.arguments.join(' ').includes('reused upstream stream during grace period')),
    true
  )
})

test('camera stream hub logs reconnect scheduling when the upstream stream drops with active listeners', async () => {
  const printer: Printer = {
    id: 'printer-1',
    name: 'Printer 1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    host: 'printer.local',
    serial: 'SERIAL-1',
    accessCode: 'CODE',
    model: 'P1S',
    currentPlateType: 'Textured PEI Plate',
    currentNozzleDiameters: [{ extruderId: 0, diameter: '0.4' }],
    position: 0
  }

  let attempts = 0
  const warn = mock.method(console, 'warn', () => undefined)
  const hub = new CameraStreamHub({
    gracePeriodMs: 0,
    framePacer: passthroughPacer,
    streamRetryDelayMs: 1,
    getPrinter: () => printer,
    readFrames: async function* (_printer, signal): AsyncGenerator<Buffer, void, void> {
      if (attempts === 0) {
        attempts += 1
        throw new Error('boom')
      }

      yield Buffer.from('frame-after-reconnect')

      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
  })

  const unsubscribe = hub.subscribe(printer.id, () => undefined)
  await delay(10)
  unsubscribe()
  await delay(5)

  assert.equal(
    warn.mock.calls.some((call) => call.arguments.join(' ').includes('scheduling reconnect #1')),
    true
  )
})