import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowsInsufficientFilament, resolveQueueDispatchConsents } from './dispatch-consent.js'

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

test('an unattended sweep consents to low filament but never to a blacklisted material', () => {
  // The asymmetry is the whole point: a shortfall makes the printer pause, which it handles, while
  // a material Bambu forbids on this hardware damages it and nobody is present to accept that.
  const sweep = resolveQueueDispatchConsents('unattended-sweep')
  assert.equal(sweep.allowInsufficientFilament, true)
  assert.equal(sweep.allowBlacklistedFilament, false)
  assert.equal(sweep.allowPrinterModelMismatch, false)
})

test('a person start carries their own answers, and only theirs', () => {
  assert.deepEqual(
    resolveQueueDispatchConsents('person-start', { allowInsufficientFilament: true, allowBlacklistedFilament: true }),
    { allowInsufficientFilament: true, allowBlacklistedFilament: true, allowPrinterModelMismatch: false }
  )
  assert.deepEqual(
    resolveQueueDispatchConsents('person-start'),
    { allowInsufficientFilament: false, allowBlacklistedFilament: false, allowPrinterModelMismatch: false }
  )
  // One answer must never imply the other.
  assert.deepEqual(
    resolveQueueDispatchConsents('person-start', { allowInsufficientFilament: true }),
    { allowInsufficientFilament: true, allowBlacklistedFilament: false, allowPrinterModelMismatch: false }
  )
})

test('a dry run withholds both, so each guard runs and can be reported', () => {
  assert.deepEqual(
    resolveQueueDispatchConsents('dry-run', { allowInsufficientFilament: true, allowBlacklistedFilament: true }),
    { allowInsufficientFilament: false, allowBlacklistedFilament: false, allowPrinterModelMismatch: false }
  )
})

test('only a person can consent to a printer-model mismatch', () => {
  assert.equal(resolveQueueDispatchConsents('person-start', { allowPrinterModelMismatch: true }).allowPrinterModelMismatch, true)
  assert.equal(resolveQueueDispatchConsents('unattended-sweep', { allowPrinterModelMismatch: true }).allowPrinterModelMismatch, false)
  assert.equal(resolveQueueDispatchConsents('dry-run', { allowPrinterModelMismatch: true }).allowPrinterModelMismatch, false)
})
