/**
 * Periodic bridge update scheduling shared by every self-updating packaging.
 *
 * A run schedules its successor only after it settles, so a slow download or
 * server outage cannot accumulate overlapping checks. Jitter prevents a fleet
 * whose bridges started together from reaching the release endpoint together.
 */

const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000
const AUTO_UPDATE_JITTER_MS = 30 * 60 * 1000

interface ScheduledTimer {
  unref(): unknown
}

interface PeriodicBridgeUpdateOptions {
  intervalMs?: number
  jitterMs?: number
  random?: () => number
  schedule?: (callback: () => void, delayMs: number) => ScheduledTimer
  onError?: (error: unknown) => void
}

/**
 * Starts a non-blocking update loop and returns after arming its first timer.
 * Failed checks are reported and retried on the normal cadence; runs never overlap.
 */
export function schedulePeriodicBridgeUpdate(
  run: () => Promise<void>,
  options: PeriodicBridgeUpdateOptions = {}
): void {
  const intervalMs = options.intervalMs ?? AUTO_UPDATE_INTERVAL_MS
  const jitterMs = options.jitterMs ?? AUTO_UPDATE_JITTER_MS
  const random = options.random ?? Math.random
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const onError = options.onError ?? ((error) => {
    console.warn(`Periodic bridge update failed: ${(error as Error).message}`)
  })

  const scheduleNext = (): void => {
    const delayMs = intervalMs + Math.floor(random() * jitterMs)
    const timer = schedule(() => {
      void run()
        .catch(onError)
        .finally(scheduleNext)
    }, delayMs)
    timer.unref()
  }

  scheduleNext()
}
