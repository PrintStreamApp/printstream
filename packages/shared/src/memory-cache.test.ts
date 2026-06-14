import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryLruCache } from './memory-cache.js'

test('MemoryLruCache evicts the least recently used entry when full', () => {
  let now = 0
  const cache = new MemoryLruCache<string, string>({
    maxEntries: 2,
    ttlMs: 1_000,
    now: () => now
  })

  cache.set('a', 'alpha')
  cache.set('b', 'bravo')
  assert.equal(cache.get('a'), 'alpha')

  now += 1
  cache.set('c', 'charlie')

  assert.equal(cache.get('a'), 'alpha')
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 'charlie')
})

test('MemoryLruCache expires entries after the configured ttl', () => {
  let now = 0
  const cache = new MemoryLruCache<string, string>({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now
  })

  cache.set('a', 'alpha')
  now = 99
  assert.equal(cache.get('a'), 'alpha')

  now = 100
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size, 0)
})

test('MemoryLruCache disabled mode behaves like a permanent cache miss', () => {
  const cache = new MemoryLruCache<string, string>({
    maxEntries: 2,
    ttlMs: 100,
    enabled: false
  })

  cache.set('a', 'alpha')

  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.size, 0)
})