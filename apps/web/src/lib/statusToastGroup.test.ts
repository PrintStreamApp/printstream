import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatStatusToastGroupHeadline,
  summarizeStatusToastGroup,
  type StatusToastGroupMember
} from './statusToastGroup'

const DISPATCH_WORDING = { activeVerb: 'Sending', noun: 'print', doneWord: 'sent' }

function member(overrides: Partial<StatusToastGroupMember> = {}): StatusToastGroupMember {
  return { active: false, color: 'success', progress: null, ...overrides }
}

test('summarizeStatusToastGroup lets a failure outrank work still running', () => {
  const summary = summarizeStatusToastGroup([
    member({ active: true, color: 'primary', progress: 40 }),
    member({ color: 'danger' })
  ])

  assert.equal(summary.color, 'danger')
  assert.equal(summary.busy, true)
  assert.equal(summary.failedCount, 1)
})

test('summarizeStatusToastGroup counts an extent-less active item as zero', () => {
  const summary = summarizeStatusToastGroup([
    member({ active: true, color: 'primary', progress: 80 }),
    member({ active: true, color: 'neutral', progress: null })
  ])

  assert.equal(summary.progress, 40)
})

test('summarizeStatusToastGroup reports no extent when nothing running has one', () => {
  const summary = summarizeStatusToastGroup([
    member({ active: true, color: 'neutral', progress: null }),
    member({ color: 'success', progress: 100 })
  ])

  assert.equal(summary.progress, null)
  assert.equal(summary.color, 'primary')
})

test('summarizeStatusToastGroup settles on the worst finished tone', () => {
  assert.equal(summarizeStatusToastGroup([member({ color: 'warning' }), member({ color: 'success' })]).color, 'warning')
  assert.equal(summarizeStatusToastGroup([member({ color: 'success' })]).color, 'success')
  assert.equal(summarizeStatusToastGroup([]).color, 'neutral')
  assert.equal(summarizeStatusToastGroup([]).busy, false)
})

test('formatStatusToastGroupHeadline counts what is running against what is listed', () => {
  const allRunning = summarizeStatusToastGroup([
    member({ active: true, color: 'primary', progress: 10 }),
    member({ active: true, color: 'neutral', progress: null })
  ])
  // The finished one is still a row in the toast, so the headline names it too:
  // "Sending 2 prints" above three rows reads as a miscount.
  const someFinished = summarizeStatusToastGroup([
    member({ active: true, color: 'primary', progress: 10 }),
    member({ active: true, color: 'neutral', progress: null }),
    member({ color: 'success' })
  ])

  assert.equal(formatStatusToastGroupHeadline(allRunning, DISPATCH_WORDING), 'Sending 2 prints')
  assert.equal(formatStatusToastGroupHeadline(someFinished, DISPATCH_WORDING), 'Sending 2 of 3 prints')
})

test('formatStatusToastGroupHeadline keeps a failure visible while others run', () => {
  const summary = summarizeStatusToastGroup([
    member({ active: true, color: 'primary', progress: 10 }),
    member({ color: 'danger' })
  ])

  assert.equal(formatStatusToastGroupHeadline(summary, DISPATCH_WORDING), 'Sending 1 of 2 prints - 1 failed')
})

test('formatStatusToastGroupHeadline reports a settled batch in the past tense', () => {
  const summary = summarizeStatusToastGroup([member(), member()])

  assert.equal(formatStatusToastGroupHeadline(summary, DISPATCH_WORDING), '2 prints sent')
})

test('formatStatusToastGroupHeadline names how many of a settled batch failed', () => {
  const partial = summarizeStatusToastGroup([member({ color: 'danger' }), member(), member()])
  const total = summarizeStatusToastGroup([member({ color: 'danger' }), member({ color: 'danger' })])

  assert.equal(formatStatusToastGroupHeadline(partial, DISPATCH_WORDING), '1 of 3 prints failed')
  assert.equal(formatStatusToastGroupHeadline(total, DISPATCH_WORDING), '2 prints failed')
})
