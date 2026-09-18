import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startOfferLifecycle } from './offerLifecycle'

/** Deterministic idle/foreground harness: no sleeps, native bridge, or HTTP server. */
function harness(ready: (signal: AbortSignal) => Promise<boolean>) {
  let busy = false
  let offered = 0
  let nextTimer = 0
  let idle: (() => void) | undefined
  let resume: (() => void) | undefined
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const lifecycle = startOfferLifecycle({
    ready,
    offer() { offered++ },
    isBusy: () => busy,
    subscribeIdle(listener) { idle = listener; return () => { idle = undefined } },
    subscribeResume(listener) { resume = listener; return () => { resume = undefined } },
    setTimer(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer },
    clearTimer(timer) { timers.delete(timer as number) }
  })
  return {
    lifecycle,
    timers,
    offered: () => offered,
    subscribed: () => Boolean(idle || resume),
    busy(value: boolean) { busy = value; idle?.() },
    resume() { resume?.() },
    async tick() {
      const entry = timers.entries().next().value
      if (!entry) return
      timers.delete(entry[0])
      entry[1].callback()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('waits for idle, reads fresh state after a competing dialog, and offers only once', async () => {
  const pending = deferred<boolean>()
  let checks = 0
  const h = harness(async () => ++checks === 1 ? pending.promise : true)
  h.busy(true)
  await h.tick()
  assert.equal(checks, 0)
  h.busy(false)
  await h.tick()
  h.busy(true)
  pending.resolve(true)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.offered(), 0)
  h.busy(false)
  await h.tick()
  assert.equal(checks, 2)
  assert.equal(h.offered(), 1)
  h.resume()
  h.busy(false)
  await h.tick()
  assert.equal(h.offered(), 1)
  h.lifecycle.dispose()
})

test('retries transient failures with a bounded backoff and recovers without reload', async () => {
  let attempts = 0
  const h = harness(async () => {
    if (++attempts < 3) throw new Error('temporarily offline')
    return true
  })
  await h.tick()
  assert.equal([...h.timers.values()][0]?.delay, 1000)
  await h.tick()
  assert.equal([...h.timers.values()][0]?.delay, 2000)
  await h.tick()
  assert.equal(h.offered(), 1)
  h.lifecycle.dispose()
})

test('stops retrying persistent failures but retries on foreground/reconnect', async () => {
  let recovered = false
  const h = harness(async () => {
    if (!recovered) throw new Error('offline')
    return true
  })
  for (let attempt = 0; attempt < 4; attempt++) await h.tick()
  assert.equal(h.timers.size, 0)
  assert.equal(h.offered(), 0)
  recovered = true
  h.resume()
  await h.tick()
  assert.equal(h.offered(), 1)
  h.lifecycle.dispose()
})

test('unconfigured or already enrolled devices stay silent and can be rechecked on resume', async () => {
  let ready = false
  const h = harness(async () => ready)
  await h.tick()
  assert.equal(h.offered(), 0)
  assert.equal(h.timers.size, 0)
  ready = true
  h.resume()
  await h.tick()
  assert.equal(h.offered(), 1)
  h.lifecycle.dispose()
})

test('scope disposal aborts the lookup, removes listeners, and ignores its late completion', async () => {
  const pending = deferred<boolean>()
  let signal: AbortSignal | undefined
  const old = harness(async (value) => { signal = value; return pending.promise })
  await old.tick()
  old.lifecycle.dispose()
  assert.equal(signal?.aborted, true)
  assert.equal(old.lifecycle.isActive(), false)
  assert.equal(old.subscribed(), false)
  assert.equal(old.timers.size, 0)
  const next = harness(async () => true)
  pending.resolve(true)
  await next.tick()
  assert.equal(old.offered(), 0)
  assert.equal(next.offered(), 1)
  next.lifecycle.dispose()
})

test('a cancelled idle timer never checks readiness', async () => {
  let checks = 0
  const h = harness(async () => { checks++; return true })
  h.lifecycle.dispose()
  await h.tick()
  assert.equal(checks, 0)
  assert.equal(h.offered(), 0)
})
