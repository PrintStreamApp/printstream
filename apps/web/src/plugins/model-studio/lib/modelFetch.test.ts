import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchModelBytes, fetchModelText, ModelFetchStallError } from './modelFetch'

/**
 * Build a fake `fetch` whose body either streams the given chunks or stalls forever. The
 * stalling reader rejects when the request signal aborts — mirroring real fetch semantics, so
 * the stall-timeout path is exercised end to end.
 */
function installFakeFetch(opts: { chunks?: Uint8Array[]; stallForever?: boolean; status?: number }) {
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal | undefined
    let index = 0
    const body = {
      getReader() {
        return {
          read() {
            if (opts.stallForever) {
              return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
              })
            }
            const chunks = opts.chunks ?? []
            if (index < chunks.length) return Promise.resolve({ done: false, value: chunks[index++] })
            return Promise.resolve({ done: true, value: undefined })
          },
          cancel() {}
        }
      }
    }
    return Promise.resolve({ ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, body })
  }) as unknown as typeof fetch
  return () => { globalThis.fetch = original }
}

test('fetchModelBytes assembles streamed chunks into the full body', async () => {
  const restore = installFakeFetch({ chunks: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])] })
  try {
    const bytes = await fetchModelBytes('https://example.test/mesh')
    assert.deepEqual([...bytes], [1, 2, 3, 4, 5])
  } finally {
    restore()
  }
})

test('fetchModelText decodes the streamed body as UTF-8', async () => {
  const restore = installFakeFetch({ chunks: [new TextEncoder().encode('<model/>')] })
  try {
    assert.equal(await fetchModelText('https://example.test/entry'), '<model/>')
  } finally {
    restore()
  }
})

test('fetchModelBytes throws ModelFetchStallError when the body stalls', async () => {
  const restore = installFakeFetch({ stallForever: true })
  try {
    await assert.rejects(
      fetchModelBytes('https://example.test/mesh', {}, 30, 45_000, 1),
      (error: unknown) => error instanceof ModelFetchStallError
    )
  } finally {
    restore()
  }
})

test('fetchModelBytes rejects on a non-OK status', async () => {
  const restore = installFakeFetch({ status: 404 })
  try {
    await assert.rejects(fetchModelBytes('https://example.test/missing'))
  } finally {
    restore()
  }
})

test('fetchModelBytes caps how many downloads run at once', async () => {
  // Hold every response body open until `release()`, so all started fetches stay "in flight"
  // (holding a concurrency slot) at the same time. The cap means only MODEL_FETCH_MAX_CONCURRENT
  // (5) of the launched requests actually call fetch() until a slot frees.
  let started = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = globalThis.fetch
  globalThis.fetch = (() => {
    started += 1
    const body = {
      getReader() {
        let read = false
        return {
          async read() {
            await gate
            if (!read) { read = true; return { done: false, value: new Uint8Array([1]) } }
            return { done: true, value: undefined }
          },
          cancel() {}
        }
      }
    }
    return Promise.resolve({ ok: true, status: 200, body })
  }) as unknown as typeof fetch
  try {
    const all = Promise.all(Array.from({ length: 8 }, () => fetchModelBytes('https://example.test/mesh')))
    // Let queued acquirers settle: only the slot-holders have called fetch() while gated.
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(started, 5, `expected the 5-slot cap to gate concurrency, saw ${started}`)
    release()
    await all
    assert.equal(started, 8) // the remaining 3 ran once slots freed
  } finally {
    globalThis.fetch = original
  }
})

test('fetchModelBytes throws ModelFetchStallError if the response never starts', async () => {
  // A fetch that hangs before producing a response (no headers) must fail on the headers budget,
  // not hang forever — this is the connect/queue/time-to-first-byte guard.
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init: RequestInit = {}) => {
    const signal = init.signal as AbortSignal | undefined
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    })
  }) as unknown as typeof fetch
  try {
    await assert.rejects(
      // stallMs large, headersMs small, single attempt: the pre-response phase should trip here.
      fetchModelBytes('https://example.test/slow', {}, 1000, 30, 1),
      (error: unknown) => error instanceof ModelFetchStallError
    )
  } finally {
    globalThis.fetch = original
  }
})

test('fetchModelBytes retries once after a stall, then succeeds', async () => {
  let attempts = 0
  const original = globalThis.fetch
  globalThis.fetch = ((_url: string, init: RequestInit = {}) => {
    attempts += 1
    const stall = attempts === 1 // first attempt hangs mid-body; the retry streams normally
    const signal = init.signal as AbortSignal | undefined
    let index = 0
    const body = {
      getReader() {
        return {
          read() {
            if (stall) {
              return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
              })
            }
            const chunks = [new Uint8Array([7, 8, 9])]
            if (index < chunks.length) return Promise.resolve({ done: false, value: chunks[index++] })
            return Promise.resolve({ done: true, value: undefined })
          },
          cancel() {}
        }
      }
    }
    return Promise.resolve({ ok: true, status: 200, body })
  }) as unknown as typeof fetch
  try {
    const bytes = await fetchModelBytes('https://example.test/mesh', {}, 30) // default attempts = 2
    assert.deepEqual([...bytes], [7, 8, 9])
    assert.equal(attempts, 2)
  } finally {
    globalThis.fetch = original
  }
})
