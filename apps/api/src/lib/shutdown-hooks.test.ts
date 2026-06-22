import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { clearShutdownHooksForTests, registerShutdownHook, runShutdownHooks } from './shutdown-hooks.js'

afterEach(() => clearShutdownHooksForTests())

test('runShutdownHooks invokes every registered hook', async () => {
  const calls: string[] = []
  registerShutdownHook(() => { calls.push('a') })
  registerShutdownHook(async () => { calls.push('b') })
  await runShutdownHooks()
  assert.deepEqual(calls.sort(), ['a', 'b'])
})

test('a throwing or rejecting hook does not prevent the others from running', async () => {
  const calls: string[] = []
  registerShutdownHook(() => { throw new Error('sync boom') })
  registerShutdownHook(async () => { throw new Error('async boom') })
  registerShutdownHook(() => { calls.push('ran') })
  await assert.doesNotReject(() => runShutdownHooks())
  assert.deepEqual(calls, ['ran'])
})

test('with no hooks registered it resolves cleanly', async () => {
  await assert.doesNotReject(() => runShutdownHooks())
})
