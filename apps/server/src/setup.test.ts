import assert from 'node:assert/strict'
import { test } from 'node:test'
import { statusMeansInstalled, statusMeansRunning } from './setup.js'

test('statusMeansInstalled treats absent-service controller strings as not installed', () => {
  for (const absent of ['NonExistent', 'not-installed', '', '   ', undefined, null]) {
    assert.equal(statusMeansInstalled(absent), false, `expected ${String(absent)} to read as not installed`)
  }
})

test('statusMeansInstalled treats any other non-empty status as installed', () => {
  for (const present of ['Running', 'Stopped', 'active (running)', 'inactive']) {
    assert.equal(statusMeansInstalled(present), true, `expected ${present} to read as installed`)
  }
})

test('statusMeansRunning only matches running/active controller strings', () => {
  assert.equal(statusMeansRunning('Running'), true)
  assert.equal(statusMeansRunning('active'), true)
  assert.equal(statusMeansRunning('active (running)'), true)
  assert.equal(statusMeansRunning('Stopped'), false)
  assert.equal(statusMeansRunning('inactive'), false)
  assert.equal(statusMeansRunning(null), false)
})
