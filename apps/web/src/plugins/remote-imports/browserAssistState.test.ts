import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getBrowserAssistStatusCopy } from './browserAssistState'

// Asserting TONE rather than the sentences: the wording will keep being edited, but
// "a missing helper is not a failure" is the rule that keeps getting lost. The helper
// is optional everywhere except a Printables page, so dressing its absence as a
// warning tells users to go install something they mostly do not need.
test('a missing helper reads as a normal state, not an error', () => {
  const copy = getBrowserAssistStatusCopy(false)
  assert.ok(copy)
  assert.equal(copy.color, 'neutral')
  assert.doesNotMatch(copy.title, /error|failed|problem|required/i)
})

test('a detected helper reads as success', () => {
  const copy = getBrowserAssistStatusCopy(true)
  assert.ok(copy)
  assert.equal(copy.color, 'success')
})

// A flash of "not installed" before the probe answers would be a claim we cannot back.
test('says nothing while the probe is still out', () => {
  assert.equal(getBrowserAssistStatusCopy(null), null)
})
