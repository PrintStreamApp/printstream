import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowsInsufficientFilament } from './dispatch-consent.js'

test('a person starting a print consents only as far as they answered', () => {
  assert.equal(allowsInsufficientFilament('person-start', true), true)
  assert.equal(allowsInsufficientFilament('person-start', false), false)
})

test('an unanswered person-start withholds consent rather than assuming it', () => {
  // The defect this pins: the flag used to come from a parameter defaulting to
  // true, so a caller that simply forgot it granted the override silently.
  assert.equal(allowsInsufficientFilament('person-start'), false)
})

test('the unattended sweep consents, because nobody is there to answer', () => {
  assert.equal(allowsInsufficientFilament('unattended-sweep'), true)
  // A person's stale answer must not narrow the sweep, which has no person.
  assert.equal(allowsInsufficientFilament('unattended-sweep', false), true)
})

test('the dry run withholds, so the check runs and it can report what was found', () => {
  // It must not report that as a FAILURE -- neither real path fails on it -- so the
  // caller downgrades the refusal to an advisory. Consenting here instead would make
  // "Check" the one surface silent about a slot that is about to run out.
  assert.equal(allowsInsufficientFilament('dry-run'), false)
  assert.equal(allowsInsufficientFilament('dry-run', true), false)
})
