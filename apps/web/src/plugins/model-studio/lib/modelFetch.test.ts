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
      fetchModelBytes('https://example.test/mesh', {}, 30),
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
