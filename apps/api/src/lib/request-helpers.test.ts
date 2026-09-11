import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import type { Request, Response } from 'express'
import { sendModelBuffer } from './request-helpers.js'

/**
 * Minimal Response stand-in capturing what `sendModelBuffer` sets/sends. It is a real Writable so
 * the streamed (chunked) gzip path can pipe into it; `send()` is captured separately for the
 * raw/tiny paths that still use `res.send()`.
 */
function mockResponse(options: { failWriteAt?: number } = {}) {
  const headers: Record<string, string> = {}
  const varies: string[] = []
  let sent: Buffer | undefined
  const streamedChunks: Buffer[] = []
  let writes = 0
  class Res extends Writable {
    readonly headersSent = true
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    }
    vary(field: string) {
      varies.push(field)
    }
    send(body: Buffer) {
      sent = body
    }
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void) {
      writes += 1
      if (writes === options.failWriteAt) {
        cb(new Error('simulated socket failure'))
        return
      }
      streamedChunks.push(Buffer.from(chunk))
      cb()
    }
  }
  const res = new Res()
  return {
    res: res as unknown as Response,
    headers,
    varies,
    get sent() {
      return sent
    },
    /** The body delivered via the streamed (chunked) path, if any. */
    get streamed() {
      return streamedChunks.length ? Buffer.concat(streamedChunks) : undefined
    },
    /** How many writes the body arrived in: the proxy-survival property, not just the bytes. */
    get chunkCount() {
      return streamedChunks.length
    }
  }
}

function mockRequest(acceptEncoding?: string, options: { aborted?: boolean } = {}): Request {
  return {
    headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {},
    aborted: options.aborted ?? false,
    originalUrl: '/api/library/file-1/archive'
  } as unknown as Request
}

test('sendModelBuffer streams gzipped large payloads when the client accepts gzip', async () => {
  const payload = Buffer.from('<model>'.repeat(2000), 'utf8') // well over the 4 KB threshold
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip, deflate, br'), ctx.res, payload, 'application/xml; charset=utf-8')

  assert.equal(ctx.headers['content-type'], 'application/xml; charset=utf-8')
  assert.equal(ctx.headers['content-encoding'], 'gzip')
  assert.deepEqual(ctx.varies, ['Accept-Encoding'])
  // Streamed in chunks (no res.send): collect them and verify they're the compressed payload.
  assert.ok(ctx.streamed && ctx.streamed.length < payload.length, 'compressed body should be smaller')
  assert.deepEqual(gunzipSync(ctx.streamed!), payload, 'gunzipped streamed body should match the original')
})

test('sendModelBuffer sends raw bytes when the client does not accept gzip', async () => {
  const payload = Buffer.from('<model>'.repeat(2000), 'utf8')
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest(undefined), ctx.res, payload, 'application/xml; charset=utf-8')

  assert.equal(ctx.headers['content-encoding'], undefined)
  assert.deepEqual(ctx.streamed, payload)
})

test('sendModelBuffer skips compression for tiny payloads even when gzip is accepted', async () => {
  const payload = Buffer.from('<model/>', 'utf8') // under the 4 KB threshold
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip'), ctx.res, payload, 'model/stl')

  assert.equal(ctx.headers['content-encoding'], undefined)
  assert.deepEqual(ctx.streamed, payload)
})

test('sendModelBuffer skips recompressing an already-compressed container', async () => {
  const payload = Buffer.alloc(512 * 1024, 0x41)
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip'), ctx.res, payload, 'model/3mf', { compress: false })

  assert.equal(ctx.headers['content-encoding'], undefined)
  assert.deepEqual(ctx.varies, [])
  assert.equal(ctx.headers['content-length'], String(payload.length))
  assert.deepEqual(ctx.streamed, payload)
})

// The declared length is the only thing that makes a short body fail loudly instead of reaching
// the client as a silently truncated file. Assert it on BOTH paths and against the bytes actually
// written, not against the caller's buffer, on the gzip path those differ.
test('sendModelBuffer declares a Content-Length matching the bytes it writes', async () => {
  for (const acceptEncoding of ['gzip, deflate, br', undefined]) {
    const payload = Buffer.from('<model>'.repeat(2000), 'utf8')
    const ctx = mockResponse()

    await sendModelBuffer(mockRequest(acceptEncoding), ctx.res, payload, 'model/3mf')

    assert.equal(ctx.headers['content-length'], String(ctx.streamed!.length))
    assert.equal(ctx.headers['x-uncompressed-content-length'], String(payload.length))
  }
})

test('sendModelBuffer writes the body in more than one chunk', async () => {
  // Small chunks are what survive a size-limited proxy; a single large write is what got truncated.
  const payload = Buffer.alloc(512 * 1024, 0x41)
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest(undefined), ctx.res, payload, 'model/3mf')

  assert.ok(ctx.chunkCount > 1, `expected several writes, got ${ctx.chunkCount}`)
  assert.deepEqual(ctx.streamed, payload)
})

test('sendModelBuffer logs a mid-stream failure that can no longer become an HTTP error', async () => {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const ctx = mockResponse({ failWriteAt: 2 })
    await sendModelBuffer(mockRequest(), ctx.res, Buffer.alloc(256 * 1024, 0x41), 'model/3mf')

    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /\/api\/library\/file-1\/archive/)
    assert.match(warnings[0] ?? '', /simulated socket failure/)
  } finally {
    console.warn = originalWarn
  }
})

test('sendModelBuffer does not warn for an explicitly aborted client request', async () => {
  const originalWarn = console.warn
  let warned = false
  console.warn = () => { warned = true }
  try {
    const ctx = mockResponse({ failWriteAt: 2 })
    await sendModelBuffer(mockRequest(undefined, { aborted: true }), ctx.res, Buffer.alloc(256 * 1024, 0x41), 'model/3mf')
    assert.equal(warned, false)
  } finally {
    console.warn = originalWarn
  }
})
