import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deepEqual } from './equality.js'

test('deepEqual compares primitives including NaN', () => {
  assert.equal(deepEqual(1, 1), true)
  assert.equal(deepEqual('a', 'a'), true)
  assert.equal(deepEqual(NaN, NaN), true)
  assert.equal(deepEqual(1, 2), false)
  assert.equal(deepEqual(0, '0'), false)
})

test('deepEqual compares nested arrays and objects by value', () => {
  assert.equal(deepEqual({ a: [1, 2, { b: 3 }] }, { a: [1, 2, { b: 3 }] }), true)
  assert.equal(deepEqual({ a: [1, 2, { b: 3 }] }, { a: [1, 2, { b: 4 }] }), false)
  assert.equal(deepEqual([1, 2, 3], [1, 2]), false)
})

test('deepEqual distinguishes arrays from objects and null from objects', () => {
  assert.equal(deepEqual([], {}), false)
  assert.equal(deepEqual(null, {}), false)
  assert.equal(deepEqual({ a: undefined }, {}), false)
})
