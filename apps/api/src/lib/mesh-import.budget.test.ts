import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertImportTriangleBudget } from './mesh-import.js'

const MAX = 5_000_000

test('allows a mesh at or below the triangle budget', () => {
  assert.doesNotThrow(() => assertImportTriangleBudget(0))
  assert.doesNotThrow(() => assertImportTriangleBudget(MAX))
})

test('rejects a mesh above the triangle budget (memory-exhaustion guard)', () => {
  assert.throws(() => assertImportTriangleBudget(MAX + 1), /too large to import/i)
})
