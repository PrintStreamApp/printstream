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
function mockResponse() {
  const headers: Record<string, string> = {}
  const varies: string[] = []
  let sent: Buffer | undefined
  const streamedChunks: Buffer[] = []
  class Res extends Writable {
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
    }
  }
}

function mockRequest(acceptEncoding?: string): Request {
  return { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} } as unknown as Request
}

test('sendModelBuffer streams gzipped large payloads when the client accepts gzip', async () => {
  const payload = Buffer.from('<model>'.repeat(2000), 'utf8') // well over the 4 KB threshold
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip, deflate, br'), ctx.res, payload, 'application/xml; charset=utf-8')

  assert.equal(ctx.headers['content-type'], 'application/xml; charset=utf-8')
  assert.equal(ctx.headers['content-encoding'], 'gzip')
  assert.deepEqual(ctx.varies, ['Accept-Encoding'])
  // Streamed in chunks (no res.send) — collect them and verify they're the compressed payload.
  assert.ok(ctx.streamed && ctx.streamed.length < payload.length, 'compressed body should be smaller')
  assert.deepEqual(gunzipSync(ctx.streamed!), payload, 'gunzipped streamed body should match the original')
})

test('sendModelBuffer sends raw bytes when the client does not accept gzip', async () => {
  const payload = Buffer.from('<model>'.repeat(2000), 'utf8')
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest(undefined), ctx.res, payload, 'application/xml; charset=utf-8')

  assert.equal(ctx.headers['content-encoding'], undefined)
  assert.deepEqual(ctx.sent, payload)
})

test('sendModelBuffer skips compression for tiny payloads even when gzip is accepted', async () => {
  const payload = Buffer.from('<model/>', 'utf8') // under the 4 KB threshold
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip'), ctx.res, payload, 'model/stl')

  assert.equal(ctx.headers['content-encoding'], undefined)
  assert.deepEqual(ctx.sent, payload)
})
