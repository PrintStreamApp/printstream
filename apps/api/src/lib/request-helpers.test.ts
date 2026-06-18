import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import type { Request, Response } from 'express'
import { sendModelBuffer } from './request-helpers.js'

/** Minimal Response stand-in capturing what `sendModelBuffer` sets/sends. */
function mockResponse() {
  const headers: Record<string, string> = {}
  const varies: string[] = []
  let sent: Buffer | undefined
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    vary(field: string) {
      varies.push(field)
    },
    send(body: Buffer) {
      sent = body
    }
  } as unknown as Response
  return {
    res,
    headers,
    varies,
    get sent() {
      return sent
    }
  }
}

function mockRequest(acceptEncoding?: string): Request {
  return { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} } as unknown as Request
}

test('sendModelBuffer gzips large payloads when the client accepts gzip', async () => {
  const payload = Buffer.from('<model>'.repeat(2000), 'utf8') // well over the 4 KB threshold
  const ctx = mockResponse()

  await sendModelBuffer(mockRequest('gzip, deflate, br'), ctx.res, payload, 'application/xml; charset=utf-8')

  assert.equal(ctx.headers['content-type'], 'application/xml; charset=utf-8')
  assert.equal(ctx.headers['content-encoding'], 'gzip')
  assert.deepEqual(ctx.varies, ['Accept-Encoding'])
  assert.ok(ctx.sent && ctx.sent.length < payload.length, 'compressed body should be smaller')
  assert.deepEqual(gunzipSync(ctx.sent!), payload, 'gunzipped body should match the original')
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
