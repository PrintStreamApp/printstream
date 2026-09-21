import assert from 'node:assert/strict'
import { test } from 'node:test'
import { schedulePeriodicBridgeUpdate } from './update-scheduler.js'

test('periodic bridge updates use jitter, unref timers, and never overlap', async () => {
  const callbacks: Array<() => void> = []
  const delays: number[] = []
  let unrefCount = 0
  let runCount = 0
  let releaseRun: (() => void) | null = null

  schedulePeriodicBridgeUpdate(
    async () => {
      runCount += 1
      await new Promise<void>((resolve) => { releaseRun = resolve })
    },
    {
      intervalMs: 100,
      jitterMs: 20,
      random: () => 0.5,
      schedule: (callback, delayMs) => {
        callbacks.push(callback)
        delays.push(delayMs)
        return { unref: () => { unrefCount += 1 } }
      }
    }
  )

  assert.deepEqual(delays, [110])
  assert.equal(unrefCount, 1)

  callbacks.shift()?.()
  await Promise.resolve()
  assert.equal(runCount, 1)
  assert.equal(callbacks.length, 0, 'the next timer waits for the current check to settle')

  releaseRun?.()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(delays, [110, 110])
  assert.equal(unrefCount, 2)
})

test('periodic bridge updates report failures and retain their cadence', async () => {
  const callbacks: Array<() => void> = []
  const errors: unknown[] = []

  schedulePeriodicBridgeUpdate(
    async () => { throw new Error('release endpoint unavailable') },
    {
      intervalMs: 25,
      jitterMs: 0,
      schedule: (callback) => {
        callbacks.push(callback)
        return { unref: () => {} }
      },
      onError: (error) => { errors.push(error) }
    }
  )

  callbacks.shift()?.()
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal((errors[0] as Error).message, 'release endpoint unavailable')
  assert.equal(callbacks.length, 1, 'a failed check still schedules the next attempt')
})
