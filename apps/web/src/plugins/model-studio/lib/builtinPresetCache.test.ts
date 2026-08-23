/**
 * MEASURED before this existed: opening a three-material project fired nine `resolve-filament`
 * round trips for three distinct presets, several of them concurrent duplicates: the badge, the
 * repair, the save's authoring pass and the parent lookup each resolved independently.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createBuiltinPresetCache } from './builtinPresetCache'

test('a repeat lookup of the same preset does not fetch again', async () => {
  const cache = createBuiltinPresetCache()
  let calls = 0
  const resolve = cache.memoize('filament', async (id: string) => { calls += 1; return { id } })

  assert.deepEqual(await resolve('a', 't1'), { id: 'a' })
  assert.deepEqual(await resolve('a', 't1'), { id: 'a' })
  assert.equal(calls, 1)
})

/**
 * The common case here, and the reason the PROMISE is cached rather than the value: a project's
 * slots resolve in parallel, so identical lookups overlap rather than following one another.
 */
test('concurrent lookups share one request', async () => {
  const cache = createBuiltinPresetCache()
  let calls = 0
  const resolve = cache.memoize('filament', async (id: string) => {
    calls += 1
    await new Promise((done) => setTimeout(done, 5))
    return { id }
  })

  const all = await Promise.all([resolve('a', 't1'), resolve('a', 't1'), resolve('a', 't1')])
  assert.deepEqual(all, [{ id: 'a' }, { id: 'a' }, { id: 'a' }])
  assert.equal(calls, 1, 'three simultaneous asks must be one request')
})

/** `targetId` is part of the identity, the same preset resolves differently per slicer version. */
test('the same preset against a different target is a different entry', async () => {
  const cache = createBuiltinPresetCache()
  let calls = 0
  const resolve = cache.memoize('filament', async (id: string, target: string | null) => { calls += 1; return { id, target } })

  await resolve('a', 't1')
  await resolve('a', 't2')
  await resolve('a', null)
  assert.equal(calls, 3)
})

/** Kinds share the cache but not the keyspace, so a process and a filament preset cannot collide. */
test('kinds do not collide', async () => {
  const cache = createBuiltinPresetCache()
  const process = cache.memoize('process', async (id: string) => ({ kind: 'process', id }))
  const filament = cache.memoize('filament', async (id: string) => ({ kind: 'filament', id }))

  assert.deepEqual(await process('same', 't'), { kind: 'process', id: 'same' })
  assert.deepEqual(await filament('same', 't'), { kind: 'filament', id: 'same' })
})

/**
 * A cached REJECTION would poison the preset for the life of the tab: the user would retry, get
 * the same instant failure, and have no way to recover short of a reload.
 */
test('a failed lookup is evicted so a retry can succeed', async () => {
  const cache = createBuiltinPresetCache()
  let calls = 0
  const resolve = cache.memoize('filament', async (id: string) => {
    calls += 1
    if (calls === 1) throw new Error('offline')
    return { id }
  })

  await assert.rejects(() => resolve('a', 't1'), /offline/)
  assert.equal(cache.size(), 0, 'the failure must not be retained')
  assert.deepEqual(await resolve('a', 't1'), { id: 'a' })
  assert.equal(calls, 2)
})
