/**
 * Adaptive playout (jitter) buffer for live camera frames.
 *
 * Frames travel printer -> bridge (LAN) -> API (cloud) -> browser, so by the
 * time they reach the API hub they arrive in bursts followed by gaps. Forwarding
 * them straight to viewers as they land makes playback look janky. This wraps an
 * async frame source and re-emits frames on a smoothed cadence, trading a small,
 * bounded amount of latency for steady playback.
 *
 * Invariants:
 * - Frames are emitted in arrival order, never dropped.
 * - Emission is spaced by an exponential moving average of the source's
 *   inter-arrival interval, so steady sources keep their rate while bursts are
 *   spread back out.
 * - Added latency is bounded: a frame is never held longer than `maxLatencyMs`
 *   past its arrival, so a stalled/backed-up stream catches up instead of
 *   drifting further behind real time.
 * - With `targetLatencyMs <= 0` the source is passed through untouched.
 */

const DEFAULT_TARGET_LATENCY_MS = 250
const DEFAULT_MAX_LATENCY_MS = 750
const DEFAULT_PREBUFFER_FRAMES = 2
const INTERVAL_SMOOTHING = 0.2

export interface CameraFramePacerOptions {
  /** Steady-state latency the buffer aims to hold (ms). */
  targetLatencyMs?: number
  /** Hard cap on how long a frame may be delayed past arrival (ms). */
  maxLatencyMs?: number
  /** Frames to accumulate before the first frame is released. */
  prebufferFrames?: number
  /** Aborts the buffer and stops reading the source. */
  signal?: AbortSignal
  getNow?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export type CameraFramePacer = (
  source: AsyncIterable<Buffer>,
  options?: CameraFramePacerOptions
) => AsyncGenerator<Buffer, void, void>

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve()
      return
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function* paceCameraFrames(
  source: AsyncIterable<Buffer>,
  options: CameraFramePacerOptions = {}
): AsyncGenerator<Buffer, void, void> {
  const targetLatencyMs = options.targetLatencyMs ?? DEFAULT_TARGET_LATENCY_MS
  const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS
  const prebufferFrames = Math.max(1, options.prebufferFrames ?? DEFAULT_PREBUFFER_FRAMES)
  const getNow = options.getNow ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const signal = options.signal

  if (targetLatencyMs <= 0) {
    yield* source
    return
  }

  const iterator = source[Symbol.asyncIterator]()
  const queue: Array<{ frame: Buffer; arrivedAt: number }> = []
  let producerDone = false
  let producerError: unknown = null
  let consumerDone = false

  let wake: (() => void) | null = null
  let pendingWake = false
  const notify = () => {
    if (wake) {
      const resolve = wake
      wake = null
      resolve()
    } else {
      pendingWake = true
    }
  }
  const waitForChange = (): Promise<void> => {
    if (pendingWake) {
      pendingWake = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      wake = resolve
    })
  }

  const onAbort = () => notify()
  signal?.addEventListener('abort', onAbort)

  const producer = (async () => {
    try {
      while (!signal?.aborted && !consumerDone) {
        const { value, done } = await iterator.next()
        if (done || consumerDone) break
        queue.push({ frame: value, arrivedAt: getNow() })
        notify()
      }
    } catch (error) {
      producerError = error
    } finally {
      producerDone = true
      notify()
    }
  })()

  let playoutAt: number | null = null
  let intervalMs = 0
  let lastArrivedAt: number | null = null

  try {
    while (queue.length < prebufferFrames && !producerDone && !signal?.aborted) {
      await waitForChange()
    }

    while (true) {
      if (signal?.aborted) return
      while (queue.length === 0 && !producerDone) {
        await waitForChange()
        if (signal?.aborted) return
      }
      if (queue.length === 0) {
        if (producerError) throw producerError
        return
      }

      const item = queue.shift() as { frame: Buffer; arrivedAt: number }
      const now = getNow()

      if (playoutAt === null) {
        playoutAt = now + targetLatencyMs
      } else {
        if (lastArrivedAt !== null) {
          const measured = item.arrivedAt - lastArrivedAt
          if (measured > 0) {
            intervalMs = intervalMs === 0
              ? measured
              : intervalMs * (1 - INTERVAL_SMOOTHING) + measured * INTERVAL_SMOOTHING
          }
        }
        playoutAt += intervalMs
      }
      // Bound the schedule on both sides: never emit before now (no backsteps)
      // and never hold a frame longer than maxLatencyMs past its arrival, so a
      // backed-up stream catches up instead of drifting further behind.
      const latest = item.arrivedAt + maxLatencyMs
      if (playoutAt > latest) playoutAt = latest
      if (playoutAt < now) playoutAt = now
      lastArrivedAt = item.arrivedAt

      const waitMs = playoutAt - getNow()
      if (waitMs > 0) {
        await sleep(waitMs, signal)
        if (signal?.aborted) return
      }
      yield item.frame
    }
  } finally {
    consumerDone = true
    signal?.removeEventListener('abort', onAbort)
    await Promise.resolve(iterator.return?.()).then(
      () => undefined,
      () => undefined
    )
    await producer.then(
      () => undefined,
      () => undefined
    )
  }
}
