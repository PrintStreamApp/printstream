/**
 * Stall-guarded body reader for the editor's model/mesh downloads.
 *
 * Geometry entries can be multi-megabyte. If the transport commits a response but then
 * stalls mid-body (a wedged/size-limited proxy, a flaky connection), a plain `fetch().text()`
 * never settles — and the editor's plate-build loop awaits it forever, leaving the viewport
 * stuck on the loading overlay with no way out. This drains the body chunk-by-chunk and
 * aborts when no bytes have arrived for `stallMs`, turning an infinite hang into a thrown
 * error the build loop can surface (and the user can retry).
 */

/** No body activity for this long is treated as a stalled download. */
export const MODEL_FETCH_STALL_MS = 20_000

export class ModelFetchStallError extends Error {
  constructor(message = 'The model download stalled. Check your connection and try again.') {
    super(message)
    this.name = 'ModelFetchStallError'
  }
}

/**
 * Fetch a URL and return its full body bytes, aborting if the body stalls (no data for
 * `stallMs`) or the caller's `signal` fires. Throws on a non-OK status. The stall timer is
 * (re)armed before the request and on every received chunk, so a slow-but-progressing
 * download is never killed — only a genuinely stuck one.
 */
export async function fetchModelBytes(
  url: string,
  init: RequestInit = {},
  stallMs: number = MODEL_FETCH_STALL_MS
): Promise<Uint8Array> {
  const controller = new AbortController()
  const callerSignal = init.signal ?? undefined
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason)
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true })
  }

  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const armStall = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => controller.abort(new ModelFetchStallError()), stallMs)
  }

  try {
    armStall()
    const response = await fetch(url, { ...init, signal: controller.signal })
    if (!response.ok) throw new Error(`Request failed (${response.status}).`)
    if (!response.body) {
      // No readable stream (e.g. a polyfilled environment): fall back to a single read.
      return new Uint8Array(await response.arrayBuffer())
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      armStall()
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
    // `controller.abort(reason)` surfaces as a DOMException; re-throw the stall reason as our
    // typed error so callers (and the viewport) get a clear, actionable message.
    if (controller.signal.aborted && controller.signal.reason instanceof ModelFetchStallError) {
      throw controller.signal.reason
    }
    throw error
  } finally {
    if (stallTimer) clearTimeout(stallTimer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
  }
}

/** Convenience: fetch a model entry and decode it as UTF-8 text, with the same stall guard. */
export async function fetchModelText(
  url: string,
  init: RequestInit = {},
  stallMs: number = MODEL_FETCH_STALL_MS
): Promise<string> {
  const bytes = await fetchModelBytes(url, init, stallMs)
  return new TextDecoder().decode(bytes)
}
