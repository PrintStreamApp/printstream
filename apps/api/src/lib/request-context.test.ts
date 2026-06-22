import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NextFunction, Request, Response } from 'express'
import { getCorrelationId, installRequestContext, withCorrelationId } from './request-context.js'

function fakeResponse(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  return {
    headers,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
      return this as unknown as Response
    }
  } as unknown as Response & { headers: Record<string, string> }
}

function runMiddleware(headers: Request['headers']): { id: string | null; headerValue: string } {
  const middleware = installRequestContext()
  const response = fakeResponse()
  let observed: string | null = null
  const next: NextFunction = () => { observed = getCorrelationId() }
  middleware({ headers } as Request, response, next)
  return { id: observed, headerValue: response.headers['x-request-id'] ?? '' }
}

test('correlation id is null outside any request context', () => {
  assert.equal(getCorrelationId(), null)
})

test('middleware generates an id and echoes it on X-Request-Id', () => {
  const { id, headerValue } = runMiddleware({})
  assert.ok(id, 'id should be present inside the request')
  assert.equal(headerValue, id, 'response header should match the ambient id')
})

test('middleware honors a sanitized inbound X-Request-Id', () => {
  const { id, headerValue } = runMiddleware({ 'x-request-id': 'trace-abc_123.4' })
  assert.equal(id, 'trace-abc_123.4')
  assert.equal(headerValue, 'trace-abc_123.4')
})

test('middleware rejects an unsafe inbound id and generates its own', () => {
  const { id } = runMiddleware({ 'x-request-id': 'bad id\nwith spaces' })
  assert.notEqual(id, 'bad id\nwith spaces')
  assert.ok(id && id.length > 0)
})

test('middleware rejects an over-long inbound id', () => {
  const tooLong = 'a'.repeat(129)
  const { id } = runMiddleware({ 'x-request-id': tooLong })
  assert.notEqual(id, tooLong)
})

test('the ambient id does not leak outside the middleware run', () => {
  runMiddleware({ 'x-request-id': 'scoped-id' })
  assert.equal(getCorrelationId(), null)
})

test('withCorrelationId makes an id ambient for non-HTTP entry points', () => {
  const result = withCorrelationId('job-42', () => getCorrelationId())
  assert.equal(result, 'job-42')
  assert.equal(getCorrelationId(), null)
})

test('withCorrelationId generates an id when none is supplied', () => {
  const result = withCorrelationId(null, () => getCorrelationId())
  assert.ok(result && result.length > 0)
})
