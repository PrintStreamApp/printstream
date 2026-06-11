process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  beginFtpActivity,
  isFtpActivityActive,
  onFtpActivityChange,
  resetPrinterTransportArbitrationForTests,
  waitForFtpIdle
} from './printer-transport-arbitration.js'

afterEach(() => {
  resetPrinterTransportArbitrationForTests()
})

test('waitForFtpIdle resolves after the last FTPS activity ends', async () => {
  const transitions: boolean[] = []
  const unsubscribe = onFtpActivityChange('printer-1', (active) => {
    transitions.push(active)
  })

  const endFirst = beginFtpActivity('printer-1')
  const endSecond = beginFtpActivity('printer-1')

  assert.equal(isFtpActivityActive('printer-1'), true)

  let resolved = false
  const waiting = waitForFtpIdle('printer-1').then(() => {
    resolved = true
  })

  await Promise.resolve()
  assert.equal(resolved, false)

  endFirst()
  await Promise.resolve()
  assert.equal(resolved, false)

  endSecond()
  await waiting

  assert.equal(isFtpActivityActive('printer-1'), false)
  assert.deepEqual(transitions, [true, false])
  unsubscribe()
})

test('waitForFtpIdle aborts if the caller cancels while FTPS is still active', async () => {
  const end = beginFtpActivity('printer-1')
  const controller = new AbortController()
  const waiting = waitForFtpIdle('printer-1', controller.signal)
  controller.abort()

  await assert.rejects(waiting, { name: 'AbortError' })
  end()
})