/**
 * Stall-guarded body reader for the editor's model/mesh downloads.
 *
 * Geometry entries can be multi-megabyte and, for bridge-owned files, are streamed
 * web -> API -> bridge. If the transport commits a response but then stalls mid-body (a wedged
 * proxy, a flaky connection, a momentarily stuck bridge RPC), a plain `fetch().text()` never
 * settles — and the editor's plate-build loop awaits it forever, leaving the viewport stuck. This
 * drains the body chunk-by-chunk and aborts when no bytes arrive for `stallMs`, turning an
 * infinite hang into a thrown error. A stalled attempt is RETRIED once before surfacing, because
 * most stalls here are transient (a single slow bridge RPC), and a retry quietly recovers.
 *
 * Two separate budgets, because the failure modes differ:
 *  - `headersMs` bounds the wait for the response *to start* (connect + time-to-first-byte). The
 *    concurrency-slot wait below is NOT charged against it (a request waiting its turn has not
 *    stalled), so this only fires when the server itself never responds.
 *  - `stallMs` bounds the gap *between body chunks* once the download is underway, so a genuinely
 *    wedged mid-transfer fails promptly while a slow-but-progressing one survives.
 */

/** No body activity for this long (between chunks) is treated as a stalled download. */
export const MODEL_FETCH_STALL_MS = 20_000

/**
 * No response headers within this long is treated as a stuck request. Covers connect and
 * time-to-first-byte — the concurrency-slot wait is excluded, so this is not charged against a
 * request merely waiting its turn.
 */
export const MODEL_FETCH_HEADERS_MS = 45_000

/** Total attempts (1 retry) before a stall surfaces — transient bridge stalls recover on retry. */
export const MODEL_FETCH_ATTEMPTS = 2

export class ModelFetchStallError extends Error {
  constructor(message = 'The model download stalled. Check your connection and try again.') {
    super(message)
    this.name = 'ModelFetchStallError'
  }
}

/**
 * Global cap on concurrent model downloads. The browser already limits connections per host
 * (~6 on HTTP/1.1), but for bridge-owned files each request fans out web -> API -> bridge, so
 * letting a whole plate's downloads start at once oversubscribes that path. Capping here (rather
 * than at one call site) also bounds a single multi-part import's parallel part fetches and the
 * overlap from rapidly superseded plate builds. The wait happens BEFORE the stall timers arm, so
 * queueing for a slot is never mistaken for a stalled transfer.
 */
const MODEL_FETCH_MAX_CONCURRENT = 5
let activeModelFetches = 0
const modelFetchWaiters: Array<() => void> = []

function acquireModelFetchSlot(): Promise<void> {
  if (activeModelFetches < MODEL_FETCH_MAX_CONCURRENT) {
    activeModelFetches += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    modelFetchWaiters.push(() => {
      activeModelFetches += 1
      resolve()
    })
  })
}

function releaseModelFetchSlot(): void {
  activeModelFetches -= 1
  const next = modelFetchWaiters.shift()
  if (next) next()
}

/** One fetch attempt with both stall guards. Throws {@link ModelFetchStallError} on a stall. */
async function fetchModelBytesOnce(url: string, init: RequestInit, stallMs: number, headersMs: number): Promise<Uint8Array> {
  const controller = new AbortController()
  const callerSignal = init.signal ?? undefined
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }

  // Wait for a concurrency slot before arming any timer, so time spent queued here is never charged
  // against the headers/stall budgets. Measure it anyway so a stall log can reveal slot starvation.
  const acquireStart = performance.now()
  await acquireModelFetchSlot()
  const slotWaitMs = Math.round(performance.now() - acquireStart)
  const startedAt = performance.now()

  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, phase: 'headers' | 'body') => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      // Operational log: identifies exactly which download stalled, in which phase, and whether
      // the concurrency pool was starved — without it, a stall is invisible past the user toast.
      console.warn(
        `[modelFetch] ${phase}-phase stall after ${Math.round(performance.now() - startedAt)}ms ` +
        `(slotWait=${slotWaitMs}ms, active=${activeModelFetches}, queued=${modelFetchWaiters.length}): ${url}`
      )
      controller.abort(new ModelFetchStallError())
    }, ms)
  }

  try {
    arm(headersMs, 'headers')
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`Request failed (${response.status}).`)
    if (!response.body) {
      // No readable stream (e.g. a polyfilled environment): fall back to a single read.
      if (timer) clearTimeout(timer)
      return new Uint8Array(await response.arrayBuffer())
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      arm(stallMs, 'body')
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        total += value.length
      }
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  } catch (error) {
    // `controller.abort(reason)` surfaces as a DOMException; re-throw the stall reason as our typed
    // error so callers (and the retry below) get a clear, actionable signal.
    if (controller.signal.aborted && controller.signal.reason instanceof ModelFetchStallError) {
      throw controller.signal.reason
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
    releaseModelFetchSlot()
  }
}

/**
 * Fetch a URL and return its full body bytes, aborting if the response never starts within
 * `headersMs`, the body stalls (no data for `stallMs`), or the caller's `signal` fires. Throws on
 * a non-OK status. A stalled attempt is retried up to `attempts` times (transient bridge stalls
 * recover); a caller-abort or a non-OK status is never retried.
 */
export async function fetchModelBytes(
  url: string,
  init: RequestInit = {},
  stallMs: number = MODEL_FETCH_STALL_MS,
  headersMs: number = MODEL_FETCH_HEADERS_MS,
  attempts: number = MODEL_FETCH_ATTEMPTS
): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchModelBytesOnce(url, init, stallMs, headersMs)
    } catch (error) {
      lastError = error
      const callerAborted = !!init.signal?.aborted
      if (error instanceof ModelFetchStallError && attempt < attempts && !callerAborted) {
        console.warn(`[modelFetch] retrying after stall (attempt ${attempt + 1}/${attempts}): ${url}`)
        continue
      }
      throw error
    }
  }
  throw lastError
}

/** Convenience: fetch a model entry and decode it as UTF-8 text, with the same stall guard. */
export async function fetchModelText(
  url: string,
  init: RequestInit = {},
  stallMs: number = MODEL_FETCH_STALL_MS,
  headersMs: number = MODEL_FETCH_HEADERS_MS,
  attempts: number = MODEL_FETCH_ATTEMPTS
): Promise<string> {
  const bytes = await fetchModelBytes(url, init, stallMs, headersMs, attempts)
  return new TextDecoder().decode(bytes)
}
