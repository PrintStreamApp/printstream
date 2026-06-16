/**
 * Abort-signal helpers shared across the API, bridge runtime, and web app.
 *
 * Cancellable async work (3MF parsing, FTPS transfers, camera streams, bridge
 * RPCs) signals cancellation by throwing an `Error` whose `name` is
 * `'AbortError'` — the same shape Node's `AbortController` uses — so callers can
 * detect it uniformly with `error.name === 'AbortError'`. These two helpers are
 * the single source of that contract; do not re-create them per module.
 */

/** Build the standard abort `Error` (`name === 'AbortError'`). */
export function createAbortError(message = 'Operation aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

/** Throw {@link createAbortError} when the given signal is already aborted. */
export function throwIfAborted(signal?: { aborted: boolean } | AbortSignal | null): void {
  if (signal?.aborted) throw createAbortError()
}
