import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadSupportAttachmentInChunks } from './chunkedSupportAttachmentUpload'

interface RecordedRequest {
  url: string
  method: string
  offset: string | null
  bodyBytes: number
}

const CLIENT_CHUNK_BYTES = 4 * 1024 * 1024
const UPLOAD_PATH = '/api/support/attachments'

/**
 * Drives `uploadSupportAttachmentInChunks` against a stubbed `fetch` that
 * emulates the API's begin/chunk/status/complete protocol, with an injectable
 * hook to fail specific chunk attempts so we can exercise retry-with-resume.
 *
 * The stub tracks `received` the way the server does — appends must arrive at
 * the current offset — so a client that resumes from the wrong place fails here
 * exactly as it would against the real API.
 */
async function runUpload(
  fileSize: number,
  options: {
    failChunkAttempt?: (attempt: number) => 'network' | number | null
    serverChunkSizeBytes?: number
  } = {}
): Promise<{ requests: RecordedRequest[]; received: number; progress: number[] }> {
  const requests: RecordedRequest[] = []
  const progress: number[] = []
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

    const json = (status: number, payload: unknown): Response =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })

    if (url.endsWith(`${UPLOAD_PATH}/uploads`) && method === 'POST') {
      return json(201, {
        uploadId: 'up_1',
        chunkSizeBytes: options.serverChunkSizeBytes ?? 8 * 1024 * 1024,
        uploadedBytes: 0
      })
    }
    if (url.includes('/chunks') && method === 'POST') {
      chunkAttempts += 1
      const failure = options.failChunkAttempt?.(chunkAttempts) ?? null
      if (failure === 'network') throw new TypeError('network error')
      if (typeof failure === 'number') return json(failure, { error: 'transient' })
      if (Number(offset) !== received) return json(409, { error: `Upload offset mismatch. Resume at byte ${received}.` })
      received += bodyBytes
      return json(200, { uploadedBytes: received, complete: received === fileSize })
    }
    if (url.includes('/complete') && method === 'POST') {
      return json(201, {
        attachment: { id: 'attachment-1', filename: 'a.bin', contentType: 'application/octet-stream', sizeBytes: fileSize, isImage: false }
      })
    }
    if (url.includes('/uploads/up_1') && method === 'GET') {
      return json(200, { uploadId: 'up_1', sizeBytes: fileSize, receivedBytes: received })
    }
    if (url.includes('/uploads/up_1') && method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof globalThis.fetch

  try {
    const file = new File([new Uint8Array(fileSize)], 'a.bin', { type: 'application/octet-stream' })
    const attachment = await uploadSupportAttachmentInChunks(UPLOAD_PATH, file, {
      onProgress: (fraction) => progress.push(fraction)
    })
    assert.equal(attachment.id, 'attachment-1')
    return { requests, received, progress }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('a file larger than one chunk is split into sequential chunk requests', async () => {
  const size = CLIENT_CHUNK_BYTES * 2 + 1024
  const { requests, received } = await runUpload(size)

  assert.equal(received, size)
  const chunks = requests.filter((request) => request.url.includes('/chunks'))
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map((chunk) => chunk.offset), ['0', String(CLIENT_CHUNK_BYTES), String(CLIENT_CHUNK_BYTES * 2)])
  assert.deepEqual(chunks.map((chunk) => chunk.bodyBytes), [CLIENT_CHUNK_BYTES, CLIENT_CHUNK_BYTES, 1024])
})

test('no single request carries the whole file, which is the point of chunking', async () => {
  // A proxy body limit is what forces this; 100 MB is the cloud's.
  const { requests } = await runUpload(CLIENT_CHUNK_BYTES * 3)
  for (const request of requests) {
    assert.ok(request.bodyBytes <= CLIENT_CHUNK_BYTES, `request carried ${request.bodyBytes} bytes`)
  }
})

test('the client never exceeds the chunk size the server advertises', async () => {
  const serverChunkSizeBytes = 1024
  const { requests, received } = await runUpload(4096, { serverChunkSizeBytes })

  assert.equal(received, 4096)
  const chunks = requests.filter((request) => request.url.includes('/chunks'))
  assert.equal(chunks.length, 4)
  for (const chunk of chunks) assert.ok(chunk.bodyBytes <= serverChunkSizeBytes)
})

test('a dropped chunk resumes from the server offset instead of restarting the file', async () => {
  const size = CLIENT_CHUNK_BYTES * 2
  // Fail the second chunk's first attempt.
  const { requests, received } = await runUpload(size, {
    failChunkAttempt: (attempt) => (attempt === 2 ? 'network' : null)
  })

  assert.equal(received, size)
  const chunks = requests.filter((request) => request.url.includes('/chunks'))
  // 3 attempts for 2 chunks: the failed one is retried, not the whole upload.
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map((chunk) => chunk.offset), ['0', String(CLIENT_CHUNK_BYTES), String(CLIENT_CHUNK_BYTES)])
  // The retry re-read the authoritative offset first.
  assert.ok(requests.some((request) => request.method === 'GET' && request.url.includes('/uploads/up_1')))
})

test('a 5xx on a chunk is retried rather than failing the upload', async () => {
  const { received } = await runUpload(CLIENT_CHUNK_BYTES, {
    failChunkAttempt: (attempt) => (attempt === 1 ? 503 : null)
  })
  assert.equal(received, CLIENT_CHUNK_BYTES)
})

test('progress is reported monotonically and ends at 1', async () => {
  const { progress } = await runUpload(CLIENT_CHUNK_BYTES * 2 + 512)
  assert.equal(progress.at(-1), 1)
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index]! >= progress[index - 1]!, 'progress went backwards')
  }
})

test('an upload that cannot resume gives up and abandons the session', async () => {
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url}`)
    if (url.endsWith(`${UPLOAD_PATH}/uploads`) && method === 'POST') {
      return new Response(JSON.stringify({ uploadId: 'up_1', chunkSizeBytes: 8 * 1024 * 1024, uploadedBytes: 0 }), {
        status: 201, headers: { 'content-type': 'application/json' }
      })
    }
    if (url.includes('/chunks')) throw new TypeError('network error')
    if (method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ uploadId: 'up_1', sizeBytes: 1024, receivedBytes: 0 }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  }) as typeof globalThis.fetch

  try {
    const file = new File([new Uint8Array(1024)], 'a.bin')
    await assert.rejects(
      uploadSupportAttachmentInChunks(UPLOAD_PATH, file),
      /interrupted and could not resume/
    )
    // The abandoned session's partial bytes are released now, not at the TTL.
    assert.ok(requests.some((request) => request.startsWith('DELETE ')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an aborted upload propagates instead of burning retries', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (url.endsWith(`${UPLOAD_PATH}/uploads`) && method === 'POST') {
      return new Response(JSON.stringify({ uploadId: 'up_1', chunkSizeBytes: 8 * 1024 * 1024, uploadedBytes: 0 }), {
        status: 201, headers: { 'content-type': 'application/json' }
      })
    }
    if (url.includes('/chunks')) {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if (method === 'DELETE') return new Response(null, { status: 204 })
    throw new Error(`unexpected request: ${method} ${url}`)
  }) as typeof globalThis.fetch

  try {
    const file = new File([new Uint8Array(1024)], 'a.bin')
    await assert.rejects(
      uploadSupportAttachmentInChunks(UPLOAD_PATH, file, { signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
