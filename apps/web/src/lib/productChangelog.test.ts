import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  formatProductReleaseDate,
  hasUnreadProductRelease
} from './productChangelog'

test('only notes for the running version are unread', () => {
  const releases = [{ version: '1.2.3', releasedOn: '2026-09-13', changes: ['Added release notes.'] }]
  assert.equal(hasUnreadProductRelease('1.2.3', null, releases), true)
  assert.equal(hasUnreadProductRelease('1.2.3', '1.2.3', releases), false)
  assert.equal(hasUnreadProductRelease('1.2.4', null, releases), false)
})

test('release dates are presented as date-only Toronto values', () => {
  assert.equal(formatProductReleaseDate('2026-09-13'), 'September 13, 2026')
})
