import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installProcessCrashHandlers } from './process-crash-handlers.js'

test('uncaught exception handler logs the error and exits non-zero', () => {
  const logs: Array<{ message: string; error: unknown }> = []
  const exits: number[] = []
  const handlers = installProcessCrashHandlers({
    log: (message, error) => logs.push({ message, error }),
    exit: (code) => exits.push(code)
  })
  try {
    const error = new Error('boom')
    handlers.onUncaughtException(error)
    assert.equal(exits.length, 1)
    assert.equal(exits[0], 1)
    assert.equal(logs[0]?.error, error)
    assert.match(logs[0]?.message ?? '', /uncaught exception/i)
  } finally {
    handlers.uninstall()
  }
})

test('unhandled rejection handler logs the reason and exits non-zero', () => {
  const logs: Array<{ message: string; error: unknown }> = []
  const exits: number[] = []
  const handlers = installProcessCrashHandlers({
    log: (message, error) => logs.push({ message, error }),
    exit: (code) => exits.push(code)
  })
  try {
    handlers.onUnhandledRejection('rejected reason')
    assert.equal(exits[0], 1)
    assert.equal(logs[0]?.error, 'rejected reason')
    assert.match(logs[0]?.message ?? '', /unhandled promise rejection/i)
  } finally {
    handlers.uninstall()
  }
})

test('uninstall removes the process listeners it added', () => {
  const before = process.listenerCount('uncaughtException')
  const handlers = installProcessCrashHandlers({ log: () => {}, exit: () => {} })
  assert.equal(process.listenerCount('uncaughtException'), before + 1)
  handlers.uninstall()
  assert.equal(process.listenerCount('uncaughtException'), before)
})
