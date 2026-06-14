import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadLibraryFileInChunks } from './chunkedLibraryUpload'

interface RecordedRequest {
  url: string
  method: string
  offset: string | null
  bodyBytes: number
}

const CLIENT_CHUNK_BYTES = 4 * 1024 * 1024

/**
 * Drives `uploadLibraryFileInChunks` against a stubbed `fetch` that emulates
 * the API's begin/chunk/status/complete protocol, with an injectable hook to
 * fail specific chunk attempts so we can exercise retry-with-resume.
 */
async function runUpload(
  fileSize: number,
  options: {
    failChunkAttempt?: (attempt: number) => 'network' | number | null
    /** RateLimit-* header overrides applied to the begin-upload response. */
    beginRateLimitHeaders?: Record<string, string>
  } = {}
): Promise<{ requests: RecordedRequest[]; received: number }> {
  const requests: RecordedRequest[] = []
  let received = 0
  let chunkAttempts = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const offset = headers.get('X-Upload-Offset')
    const bodyBytes = init?.body instanceof Blob ? init.body.size : 0
    requests.push({ url, method, offset, bodyBytes })

    // Generous default budget so pacing never engages unless a test overrides it.
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: {
          'content-type': 'application/json',
          'RateLimit-Limit': '120',
          'RateLimit-Remaining': '100',
          'RateLimit-Reset': '30',
          ...headers
        }
      })

    if (url.includes('/api/library/uploads') && method === 'POST' && !url.includes('/chunks') && !url.includes('/complete')) {
      return json(201, { uploadId: 'up_1', chunkSizeBytes: 16 * 1024 * 1024, uploadedBytes: 0 }, options.beginRateLimitHeaders)
    }
    if (url.includes('/chunks') && method === 'POST') {
      chunkAttempts += 1
      const failure = options.failChunkAttempt?.(chunkAttempts) ?? null
      if (failure === 'network') throw new TypeError('network error')
      if (typeof failure === 'number') {
        // 429s advertise an immediate retry window so the pacing path stays fast in tests.
        return new Response(JSON.stringify({ error: 'temporary failure' }), {
          status: failure,
          headers: { 'content-type': 'application/json', ...(failure === 429 ? { 'Retry-After': '0' } : {}) }
        })
      }
      received = Number(offset) + bodyBytes
      return json(200, { uploadedBytes: received, complete: received === fileSize })
    }
    if (url.includes('/api/library/uploads/up_1') && method === 'GET') {
      return json(200, { upload: { phase: 'receiving', sizeBytes: fileSize, receivedBytes: received, bridgeReceivedBytes: 0 } })
    }
    if (url.includes('/complete') && method === 'POST') {
      return json(200, { file: { id: 'file_1' } })
    }
    if (url.includes('/api/library/uploads/up_1') && method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    await uploadLibraryFileInChunks(new File([new Uint8Array(fileSize)], 'sign-expand-b.stl'))
    return { requests, received }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('splits large files into multiple sub-16MB chunks', async () => {
  const fileSize = 13.5 * 1024 * 1024
  const { requests, received } = await runUpload(Math.floor(fileSize))

  const chunkRequests = requests.filter((request) => request.url.includes('/chunks'))
  assert.ok(chunkRequests.length >= 4, `expected multiple chunks, got ${chunkRequests.length}`)
  for (const request of chunkRequests) {
    assert.ok(request.bodyBytes <= CLIENT_CHUNK_BYTES, 'each chunk stays within the client chunk size')
  }
  assert.equal(received, Math.floor(fileSize))
})

test('retries a failed chunk and resumes from the server offset', async () => {
  const fileSize = 5 * 1024 * 1024
  const { requests, received } = await runUpload(fileSize, {
    // Fail the second chunk's first attempt with a dropped connection.
    failChunkAttempt: (attempt) => (attempt === 2 ? 'network' : null)
  })

  assert.equal(received, fileSize)
  // A status read happens between the failed attempt and the resumed retry.
  assert.ok(requests.some((request) => request.method === 'GET' && request.url.includes('/api/library/uploads/up_1')))
})

test('pauses until the advertised write budget resets before sending more requests', async () => {
  const start = Date.now()
  const { received } = await runUpload(1024, {
    // The begin response reports the budget nearly exhausted with a 1s reset;
    // the first chunk should wait out the window instead of spending the
    // reserve kept for the rest of the app.
    beginRateLimitHeaders: { 'RateLimit-Limit': '120', 'RateLimit-Remaining': '5', 'RateLimit-Reset': '1' }
  })

  assert.equal(received, 1024)
  assert.ok(Date.now() - start >= 900, 'expected the chunk to wait for the budget window to reset')
})

test('waits out a 429 rate-limit response and finishes the upload instead of failing', async () => {
  const fileSize = 1024
  const { requests, received } = await runUpload(fileSize, {
    failChunkAttempt: (attempt) => (attempt === 1 ? 429 : null)
  })

  assert.equal(received, fileSize)
  const chunkPosts = requests.filter((request) => request.url.includes('/chunks'))
  assert.equal(chunkPosts.length, 2)
  // The upload completed rather than being cancelled after the 429.
  assert.ok(requests.some((request) => request.url.includes('/complete')))
  assert.ok(!requests.some((request) => request.method === 'DELETE'))
})
