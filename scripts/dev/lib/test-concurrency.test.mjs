import assert from 'node:assert/strict'
import test from 'node:test'

import { batchTestFiles, defaultTestConcurrency, failedTestCandidates } from './test-concurrency.mjs'

const GIB = 1024 ** 3

test('memory pressure reduces the default to one worker', () => {
  assert.equal(defaultTestConcurrency({ cpuCount: 12, availableMemoryBytes: 3.8 * GIB }), 1)
})

test('available memory permits more workers without exceeding the cap', () => {
  assert.equal(defaultTestConcurrency({ cpuCount: 12, availableMemoryBytes: 6 * GIB }), 2)
  assert.equal(defaultTestConcurrency({ cpuCount: 12, availableMemoryBytes: 9 * GIB }), 4)
  assert.equal(defaultTestConcurrency({ cpuCount: 64, availableMemoryBytes: 64 * GIB }), 4)
})

test('small CPU allocations remain the tighter bound', () => {
  assert.equal(defaultTestConcurrency({ cpuCount: 1, availableMemoryBytes: 16 * GIB }), 1)
  assert.equal(defaultTestConcurrency({ cpuCount: 2, availableMemoryBytes: 16 * GIB }), 1)
})

test('test files are split into stable bounded batches', () => {
  assert.deepEqual(batchTestFiles(['a', 'b', 'c', 'd', 'e'], 2), [
    ['a', 'b'],
    ['c', 'd'],
    ['e']
  ])
})

test('an unattributed failed batch is retained when another batch names a failure', () => {
  const firstBatch = ['/repo/a.test.ts', '/repo/b.test.ts']
  const secondBatch = ['/repo/c.test.ts', '/repo/d.test.ts']

  assert.deepEqual(failedTestCandidates([
    { files: firstBatch, output: 'subprocess exited after signal SIGKILL' },
    { files: secondBatch, output: 'failure at /repo/c.test.ts:12:3' }
  ], '/repo'), {
    candidates: ['/repo/a.test.ts', '/repo/b.test.ts', '/repo/c.test.ts'],
    unattributed: ['/repo/a.test.ts', '/repo/b.test.ts']
  })
})
