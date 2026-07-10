import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from './randomId.js'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('randomUUID returns RFC 4122 v4 ids and never repeats', () => {
  const seen = new Set<string>()
  for (let index = 0; index < 100; index += 1) {
    const id = randomUUID()
    assert.match(id, UUID_V4_PATTERN)
    assert.equal(seen.has(id), false)
    seen.add(id)
  }
})

test('randomUUID falls back when crypto.randomUUID is unavailable (insecure context)', () => {
  // Self-hosted installs served over plain HTTP have `crypto` WITHOUT
  // `randomUUID` (it is secure-context-only); getRandomValues still exists.
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true })
  try {
    const id = randomUUID()
    assert.match(id, UUID_V4_PATTERN)
    assert.notEqual(randomUUID(), id)
  } finally {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original)
  }
})
