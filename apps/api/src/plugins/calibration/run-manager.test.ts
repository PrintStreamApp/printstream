import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldApplyKValue } from './run-manager.js'

test('shouldApplyKValue only pushes a resolved value that differs from the slot', () => {
  // Nothing saved -> never push.
  assert.equal(shouldApplyKValue(null, 0.02), false)
  // Saved but printer has no K yet -> push.
  assert.equal(shouldApplyKValue(0.02, null), true)
  // Saved differs from current -> push.
  assert.equal(shouldApplyKValue(0.024, 0.02), true)
  // Saved already applied (within tolerance) -> skip the redundant MQTT write.
  assert.equal(shouldApplyKValue(0.02, 0.02), false)
  assert.equal(shouldApplyKValue(0.02, 0.020005), false)
})
