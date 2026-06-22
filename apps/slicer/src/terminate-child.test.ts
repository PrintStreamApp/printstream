import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { terminateSlicerChild } from './terminate-child.js'

afterEach(() => {
  mock.timers.reset()
})

function makeChild(pid: number | undefined) {
  const signals: string[] = []
  return {
    pid,
    signals,
    kill(signal: NodeJS.Signals) { signals.push(`direct:${signal}`); return true }
  }
}

test('signals the process group and the child with SIGTERM immediately', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const groupKills: string[] = []
  const child = makeChild(4242)
  terminateSlicerChild(child, {
    graceMs: 5_000,
    log: () => {},
    killGroup: (pid, signal) => groupKills.push(`${pid}:${signal}`)
  })
  assert.deepEqual(groupKills, ['4242:SIGTERM'])
  assert.deepEqual(child.signals, ['direct:SIGTERM'])
})

test('escalates to SIGKILL after the grace period', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const groupKills: string[] = []
  const child = makeChild(4242)
  terminateSlicerChild(child, { graceMs: 5_000, log: () => {}, killGroup: (pid, signal) => groupKills.push(`${pid}:${signal}`) })
  mock.timers.tick(5_000)
  assert.deepEqual(groupKills, ['4242:SIGTERM', '4242:SIGKILL'])
  assert.deepEqual(child.signals, ['direct:SIGTERM', 'direct:SIGKILL'])
})

test('the returned canceller prevents the SIGKILL escalation', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const groupKills: string[] = []
  const child = makeChild(4242)
  const cancel = terminateSlicerChild(child, { graceMs: 5_000, log: () => {}, killGroup: (pid, signal) => groupKills.push(`${pid}:${signal}`) })
  cancel()
  mock.timers.tick(5_000)
  assert.deepEqual(groupKills, ['4242:SIGTERM'])
})

test('falls back to a direct kill when the child has no pid (no group)', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let groupCalled = false
  const child = makeChild(undefined)
  terminateSlicerChild(child, { graceMs: 5_000, log: () => {}, killGroup: () => { groupCalled = true } })
  assert.equal(groupCalled, false)
  assert.deepEqual(child.signals, ['direct:SIGTERM'])
})
