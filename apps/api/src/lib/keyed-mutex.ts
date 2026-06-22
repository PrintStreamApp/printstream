/**
 * In-process per-key async mutex.
 *
 * `run(key, fn)` serializes work sharing a key: calls with the same key execute
 * one at a time in arrival order, while different keys run concurrently. The
 * per-key chain self-prunes once idle, so the map never grows unbounded. A
 * failed task does not block the next one for that key.
 *
 * Use it to make a read-modify-write critical section atomic within a single
 * process (e.g. appending chunks to one upload session) without a global lock.
 */
export interface KeyedMutex {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>
}

export function createKeyedMutex(): KeyedMutex {
  const tails = new Map<string, Promise<unknown>>()

  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      // Run `fn` once the previous task for this key settles, whether it
      // resolved or rejected (a prior failure must not wedge the queue).
      const next = previous.then(fn, fn)
      tails.set(key, next)
      void next.catch(() => undefined).finally(() => {
        // Drop the entry only if no newer task has been chained behind us.
        if (tails.get(key) === next) tails.delete(key)
      })
      return next
    }
  }
}
