import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadLibraryFileInChunks, uploadReconciliationDeadlineReached } from './chunkedLibraryUpload'

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
    /** RateLimit-* header overrides applied to successful chunk responses. */
    chunkRateLimitHeaders?: Record<string, string>
    signal?: AbortSignal
    onProgress?: (phase: string) => void
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
      return json(200, { uploadedBytes: received, complete: received === fileSize }, options.chunkRateLimitHeaders)
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
    await uploadLibraryFileInChunks(new File([new Uint8Array(fileSize)], 'sign-expand-b.stl'), {
      signal: options.signal,
      onProgress: (progress) => options.onProgress?.(progress.phase)
    })
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

test('a completed upload can use the write headroom reserved for finalizing', async () => {
  const startedAt = Date.now()
  const { requests } = await runUpload(1024, {
    chunkRateLimitHeaders: { 'RateLimit-Limit': '120', 'RateLimit-Remaining': '5', 'RateLimit-Reset': '2' }
  })

  assert.ok(requests.some((request) => request.url.includes('/complete')))
  // Successful uploads wait up to one 500ms polling tick while the advisory
  // progress reader shuts down. The completion itself must not add the 2s
  // rate-window wait advertised by the last chunk.
  assert.ok(Date.now() - startedAt < 900, 'completion should not wait for the reserved budget to reset')
})

test('a cancellation at the completion boundary cannot hide a committed upload', async () => {
  const requests: RecordedRequest[] = []
  const abort = new AbortController()
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const bodyBytes = init?.body instanceof Blob ? init.body.size : 0
    requests.push({ url, method, offset: headers.get('X-Upload-Offset'), bodyBytes })
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })

    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_race', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') {
      return json(200, { uploadedBytes: bodyBytes, complete: true })
    }
    if (url.includes('/complete') && method === 'POST') {
      // A real click can arrive after the lock callback has run but before React paints the
      // non-cancellable state. The completion request itself must therefore ignore the signal.
      abort.abort()
      if (init?.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
      return json(201, { file: { id: 'file_committed', name: 'project.3mf' } })
    }
    if (url.includes('/api/library/uploads/up_race') && method === 'GET') {
      return json(200, { upload: { phase: 'transferring', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 0 } })
    }
    if (url.includes('/api/library/uploads/up_race') && method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    let cancellationLocked = false
    const result = await uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'), {
      signal: abort.signal,
      // Simulate the tightest possible race: the old Cancel handler fires before React can paint
      // the locked state announced by this callback.
      onCommitStart: () => {
        cancellationLocked = true
        abort.abort()
      }
    })

    assert.equal(cancellationLocked, true)
    assert.equal(result.file.id, 'file_committed')
    assert.ok(!requests.some((request) => request.method === 'DELETE'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('completion aborts a wedged status poll and never regresses to a completed browser upload', async () => {
  const originalFetch = globalThis.fetch
  const phases: string[] = []
  let statusReads = 0
  let statusPollStarted!: () => void
  const statusPoll = new Promise<void>((resolve) => { statusPollStarted = resolve })

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_wedged_poll', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') return json(200, { uploadedBytes: 1, complete: true })
    if (url.includes('/complete') && method === 'POST') {
      await statusPoll
      await new Promise((resolve) => setTimeout(resolve, 600))
      return json(201, { file: { id: 'file_saved', name: 'project.3mf' } })
    }
    if (url.includes('/api/library/uploads/up_wedged_poll') && method === 'GET') {
      statusReads += 1
      statusPollStarted()
      if (statusReads === 1) {
        return json(200, {
          upload: { phase: 'receiving', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 0, completion: null }
        })
      }
      // Reproduce a dev proxy request that never settles on its own. The upload must abort this
      // advisory poll after completion rather than awaiting it forever.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    const result = await Promise.race([
      uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'), {
        onProgress: (progress) => phases.push(progress.phase)
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('upload remained stuck on its status poll')), 2_000))
    ])
    assert.equal(result.file.id, 'file_saved')
    const sendingIndex = phases.indexOf('sending-to-bridge')
    assert.ok(sendingIndex >= 0)
    assert.equal(phases.slice(sendingIndex + 1).includes('uploading-to-server'), false)
    assert.ok(phases.includes('waiting-for-server'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('reconciles an uncertain completion from the authoritative upload result', async () => {
  const requests: RecordedRequest[] = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const bodyBytes = init?.body instanceof Blob ? init.body.size : 0
    requests.push({ url, method, offset: headers.get('X-Upload-Offset'), bodyBytes })
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })

    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_reconcile', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') {
      return json(200, { uploadedBytes: bodyBytes, complete: true })
    }
    if (url.includes('/complete') && method === 'POST') {
      throw new DOMException('Request timed out.', 'TimeoutError')
    }
    if (url.includes('/api/library/uploads/up_reconcile') && method === 'GET') {
      return json(200, {
        upload: {
          phase: 'completed',
          sizeBytes: 1,
          receivedBytes: 1,
          bridgeReceivedBytes: 1,
          completion: {
            statusCode: 201,
            body: { file: { id: 'file_reconciled', name: 'project.3mf' }, archivedVersionId: 'version-1' }
          }
        }
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    let reconciling = false
    const result = await uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'), {
      onReconciliationStart: () => { reconciling = true }
    })

    assert.equal(reconciling, true)
    assert.equal(result.file.id, 'file_reconciled')
    assert.equal(result.archivedVersionId, 'version-1')
    assert.ok(!requests.some((request) => request.method === 'DELETE'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('replays completion for an orphaned transferring session with no result', async () => {
  const originalFetch = globalThis.fetch
  let completionPosts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_orphaned', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') return json(200, { uploadedBytes: 1, complete: true })
    if (url.includes('/complete') && method === 'POST') {
      completionPosts += 1
      if (completionPosts === 1) throw new DOMException('Request timed out.', 'TimeoutError')
      return json(201, { file: { id: 'file_resumed', name: 'project.3mf' } })
    }
    if (url.includes('/api/library/uploads/up_orphaned') && method === 'GET') {
      return json(200, {
        upload: {
          phase: 'transferring', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 0, completion: null
        }
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    const result = await uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'))
    assert.equal(result.file.id, 'file_resumed')
    assert.equal(completionPosts, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('treats a retriable completion HTTP response as uncertain and reconciles it', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_503', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') {
      return json(200, { uploadedBytes: 1, complete: true })
    }
    if (url.includes('/complete') && method === 'POST') return json(503, { error: 'temporarily unavailable' })
    if (url.includes('/api/library/uploads/up_503') && method === 'GET') {
      return json(200, {
        upload: {
          phase: 'completed', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 1,
          completion: { statusCode: 201, body: { file: { id: 'file_after_503', name: 'project.3mf' } } }
        }
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    const result = await uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'))
    assert.equal(result.file.id, 'file_after_503')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('can stop waiting as soon as uncertain completion reconciliation begins', async () => {
  const originalFetch = globalThis.fetch
  let completionPosts = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_stop_waiting', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') return json(200, { uploadedBytes: 1, complete: true })
    if (url.includes('/complete') && method === 'POST') {
      completionPosts += 1
      return json(500, { error: 'completion result unavailable' })
    }
    if (url.includes('/api/library/uploads/up_stop_waiting') && method === 'GET') {
      return json(200, {
        upload: { phase: 'receiving', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 0, completion: null }
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    await assert.rejects(
      () => uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'), {
        onReconciliationStart: (stopWaiting) => stopWaiting()
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
    )
    assert.equal(completionPosts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a terminal missing-session state can explicitly retry the same upload status', async () => {
  const originalFetch = globalThis.fetch
  let statusReads = 0
  let recoveryMessage = ''
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_retry_status', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') return json(200, { uploadedBytes: 1, complete: true })
    if (url.includes('/complete') && method === 'POST') throw new DOMException('Request timed out.', 'TimeoutError')
    if (url.includes('/api/library/uploads/up_retry_status') && method === 'GET') {
      statusReads += 1
      if (statusReads === 1) return json(404, { error: 'Upload session not found' })
      return json(200, {
        upload: {
          phase: 'completed', sizeBytes: 1, receivedBytes: 1, bridgeReceivedBytes: 1,
          completion: { statusCode: 201, body: { file: { id: 'file_recovered', name: 'project.3mf' } } }
        }
      })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    const result = await uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf'), {
      onReconciliationRequired: (retry, message) => {
        recoveryMessage = message
        retry()
      }
    })
    assert.match(recoveryMessage, /retry the status check/)
    assert.equal(result.file.id, 'file_recovered')
    assert.equal(statusReads, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an expired reconciliation window terminates orphaned completion polling', () => {
  const startedAt = 1_000
  assert.equal(uploadReconciliationDeadlineReached(startedAt, startedAt + 119_999), false)
  assert.equal(uploadReconciliationDeadlineReached(startedAt, startedAt + 120_000), true)
})

test('a missing authoritative upload session is terminal instead of polling forever', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    })
    if (url.endsWith('/api/library/uploads') && method === 'POST') {
      return json(201, { uploadId: 'up_missing', chunkSizeBytes: CLIENT_CHUNK_BYTES, uploadedBytes: 0 })
    }
    if (url.includes('/chunks') && method === 'POST') {
      return json(200, { uploadedBytes: 1, complete: true })
    }
    if (url.includes('/complete') && method === 'POST') {
      throw new DOMException('Request timed out.', 'TimeoutError')
    }
    if (url.includes('/api/library/uploads/up_missing') && method === 'GET') {
      return json(404, { error: 'Upload session not found' })
    }
    throw new Error(`Unexpected request ${method} ${url}`)
  }) as typeof fetch

  try {
    await assert.rejects(
      () => uploadLibraryFileInChunks(new File([new Uint8Array([1])], 'project.3mf')),
      /no longer has this upload result.*Check the Library/
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cancelling interrupts a proactive upload-pacing wait', async () => {
  const abort = new AbortController()
  const startedAt = Date.now()

  await assert.rejects(
    runUpload(1024, {
      beginRateLimitHeaders: { 'RateLimit-Limit': '120', 'RateLimit-Remaining': '5', 'RateLimit-Reset': '10' },
      signal: abort.signal,
      onProgress: (phase) => {
        if (phase === 'waiting-for-server') abort.abort()
      }
    }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
  )

  assert.ok(Date.now() - startedAt < 500, 'cancellation should not wait for the rate-limit window')
})
