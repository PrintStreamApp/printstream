process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paceCameraFrames } from './camera-frame-pacer.js'

/**
 * Drives the pacer with a virtual clock so emission timing is deterministic.
 * `sleep` advances the clock and resolves on the next microtask, which lets the
 * background producer keep filling the queue between emissions.
 */
function createVirtualClock() {
  let now = 0
  return {
    getNow: () => now,
    sleep: async (ms: number) => {
      now += Math.max(0, ms)
      await Promise.resolve()
    },
    advance: (ms: number) => {
      now += ms
    }
  }
}

async function* sourceWithArrivals(
  frames: Array<{ frame: Buffer; afterMs: number }>,
  clock: { advance: (ms: number) => void }
): AsyncGenerator<Buffer, void, void> {
  for (const item of frames) {
    if (item.afterMs > 0) clock.advance(item.afterMs)
    yield item.frame
  }
}

test('paceCameraFrames passes frames straight through when target latency is disabled', async () => {
  const frames = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]
  const delivered: Buffer[] = []
  for await (const frame of paceCameraFrames((async function* () {
    yield* frames
  })(), { targetLatencyMs: 0 })) {
    delivered.push(frame)
  }
  assert.deepEqual(delivered, frames)
})

test('paceCameraFrames emits every frame in order on a smoothed cadence', async () => {
  const clock = createVirtualClock()
  // Frames arrive in a burst (0/0ms) then with a gap, simulating jitter.
  const source = sourceWithArrivals([
    { frame: Buffer.from('1'), afterMs: 0 },
    { frame: Buffer.from('2'), afterMs: 0 },
    { frame: Buffer.from('3'), afterMs: 100 },
    { frame: Buffer.from('4'), afterMs: 0 }
  ], clock)

  const delivered: Array<{ frame: string; at: number }> = []
  for await (const frame of paceCameraFrames(source, {
    targetLatencyMs: 100,
    maxLatencyMs: 400,
    prebufferFrames: 2,
    getNow: clock.getNow,
    sleep: clock.sleep
  })) {
    delivered.push({ frame: frame.toString(), at: clock.getNow() })
  }

  assert.deepEqual(delivered.map((d) => d.frame), ['1', '2', '3', '4'])
  // Emission timestamps must be non-decreasing (no janky reordering/backsteps).
  for (let i = 1; i < delivered.length; i += 1) {
    const current = delivered[i]
    const previous = delivered[i - 1]
    assert.ok(
      current !== undefined && previous !== undefined && current.at >= previous.at,
      `frame ${i} emitted before previous`
    )
  }
})

test('paceCameraFrames never holds a frame longer than the max latency', async () => {
  const clock = createVirtualClock()
  // Frames arrive on a steady 50ms cadence. Prebuffering all of them means the
  // whole burst is queued (at known clock times) before any emission, so the
  // playout schedule would drift well past arrival without the max-latency clamp.
  const arrivals = [0, 50, 100, 150, 200]
  const source = sourceWithArrivals(
    arrivals.map((_, i) => ({ frame: Buffer.from(String(i)), afterMs: i === 0 ? 0 : 50 })),
    clock
  )

  const emissions: Array<{ index: number; at: number }> = []
  for await (const frame of paceCameraFrames(source, {
    targetLatencyMs: 100,
    maxLatencyMs: 250,
    prebufferFrames: arrivals.length,
    getNow: clock.getNow,
    sleep: clock.sleep
  })) {
    emissions.push({ index: Number(frame.toString()), at: clock.getNow() })
  }

  assert.equal(emissions.length, arrivals.length)
  for (const emission of emissions) {
    const arrivedAt = arrivals[emission.index] ?? 0
    assert.ok(
      emission.at - arrivedAt <= 250,
      `frame ${emission.index} held ${emission.at - arrivedAt}ms (> 250ms cap)`
    )
  }
})

test('paceCameraFrames propagates source errors after draining buffered frames', async () => {
  const clock = createVirtualClock()
  const source = (async function* () {
    yield Buffer.from('ok')
    throw new Error('upstream failed')
  })()

  const delivered: string[] = []
  await assert.rejects(async () => {
    for await (const frame of paceCameraFrames(source, {
      targetLatencyMs: 50,
      prebufferFrames: 1,
      getNow: clock.getNow,
      sleep: clock.sleep
    })) {
      delivered.push(frame.toString())
    }
  }, /upstream failed/)
  assert.deepEqual(delivered, ['ok'])
})

test('paceCameraFrames stops reading the source when the consumer breaks early', async () => {
  const clock = createVirtualClock()
  let returned = false
  const source: AsyncIterable<Buffer> = {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          return { value: Buffer.from(String(i++)), done: false }
        },
        async return() {
          returned = true
          return { value: undefined, done: true }
        }
      }
    }
  }

  for await (const _frame of paceCameraFrames(source, {
    targetLatencyMs: 10,
    prebufferFrames: 1,
    getNow: clock.getNow,
    sleep: clock.sleep
  })) {
    break
  }

  // Allow the finally cleanup microtasks to run.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(returned, true)
})

test('paceCameraFrames stops promptly when the abort signal fires', async () => {
  const clock = createVirtualClock()
  const controller = new AbortController()
  const source = (async function* () {
    yield Buffer.from('1')
    yield Buffer.from('2')
    // Never completes on its own.
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  })()

  const delivered: string[] = []
  const consume = (async () => {
    for await (const frame of paceCameraFrames(source, {
      targetLatencyMs: 10,
      prebufferFrames: 1,
      signal: controller.signal,
      getNow: clock.getNow,
      sleep: clock.sleep
    })) {
      delivered.push(frame.toString())
      if (delivered.length === 1) controller.abort()
    }
  })()

  await consume
  assert.ok(delivered.length >= 1)
})
