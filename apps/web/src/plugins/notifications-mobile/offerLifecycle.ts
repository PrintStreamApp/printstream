/**
 * Owns one scope's deferred notification offer. Checks device/server readiness
 * only after the app settles, retries transient failures three times, and can
 * recheck on foreground/reconnect. Disposal aborts HTTP work and fences every
 * late callback, including native calls which cannot themselves be cancelled.
 */
export interface OfferLifecycleOptions {
  ready(signal: AbortSignal): Promise<boolean>
  offer(): void
  isBusy(): boolean
  subscribeIdle(listener: () => void): () => void
  subscribeResume(listener: () => void): () => void
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(timer: unknown): void
}

export function startOfferLifecycle(options: OfferLifecycleOptions) {
  const abort = new AbortController()
  let offered = false
  let loading = false
  let failures = 0
  let timer: unknown

  /** Busy transitions cancel the pending idle check, never an active enrollment. */
  function schedule(delayMs = 1000) {
    options.clearTimer(timer)
    timer = undefined
    if (abort.signal.aborted || offered || loading || options.isBusy()) return
    timer = options.setTimer(() => { void check() }, delayMs)
  }

  async function check() {
    if (abort.signal.aborted || offered || loading || options.isBusy()) return
    loading = true
    let retryDelay: number | null = null
    try {
      const ready = await options.ready(abort.signal)
      if (abort.signal.aborted) return
      failures = 0
      if (ready && !options.isBusy()) {
        offered = true
        options.offer()
      }
      // If another dialog opened while checking, its next idle event triggers
      // a NEW readiness check, not an offer based on the old device snapshot.
    } catch {
      failures += 1
      if (failures <= 3) retryDelay = 1000 * 2 ** (failures - 1)
    } finally {
      loading = false
      if (retryDelay !== null) schedule(retryDelay)
    }
  }

  const stopIdle = options.subscribeIdle(() => schedule())
  const stopResume = options.subscribeResume(() => {
    failures = 0
    schedule()
  })
  schedule()

  return {
    /** Also fences the component's late enrollment results after a scope change. */
    isActive: () => !abort.signal.aborted,
    dispose() {
      abort.abort()
      options.clearTimer(timer)
      stopIdle()
      stopResume()
    }
  }
}
