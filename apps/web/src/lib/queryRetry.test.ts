import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from './apiClient'
import { shouldRetryQuery } from './queryRetry'

const apiError = (status: number): ApiError => new ApiError(`failed (${status})`, status, null, null)

test('a refused request is never retried', () => {
  // The bug this pins: a 403 retried three times with backoff left the platform
  // Customers view blank for about seven seconds, then showed an error next to
  // an empty state. The answer cannot change between attempts.
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(shouldRetryQuery(0, apiError(status)), false, `${status} should not retry`)
  }
})

test('"not now" is retried, unlike "no"', () => {
  for (const status of [408, 429]) {
    assert.equal(shouldRetryQuery(0, apiError(status)), true, `${status} should retry`)
  }
})

test('server faults and transport failures still retry, up to the limit', () => {
  assert.equal(shouldRetryQuery(0, apiError(500)), true)
  assert.equal(shouldRetryQuery(2, apiError(503)), true)
  assert.equal(shouldRetryQuery(3, apiError(500)), false, 'stops at the retry limit')
  // No status at all: the transport failed rather than the server answering.
  assert.equal(shouldRetryQuery(0, new TypeError('Failed to fetch')), true)
  assert.equal(shouldRetryQuery(3, new TypeError('Failed to fetch')), false)
})
