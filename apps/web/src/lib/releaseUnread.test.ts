import assert from 'node:assert/strict'
import test from 'node:test'
import { getUnreadReleaseEntries } from './releaseUnread'

const releases = [
  { version: '3.0.0', changes: ['Newest.', 'Another change.'] },
  { version: '2.0.0', changes: ['Middle.'] },
  { version: '1.0.0', changes: ['Oldest.'] }
]

test('skipped releases are unread, through the running version only', () => {
  assert.deepEqual(getUnreadReleaseEntries('3.0.0', '1.0.0', releases).map((entry) => entry.version), ['3.0.0', '2.0.0'])
  assert.deepEqual(getUnreadReleaseEntries('2.0.0', '1.0.0', releases).map((entry) => entry.version), ['2.0.0'])
})

test('first use and an unrecognized marker preserve the current-release-only baseline', () => {
  assert.deepEqual(getUnreadReleaseEntries('2.0.0', null, releases).map((entry) => entry.version), ['2.0.0'])
  assert.deepEqual(getUnreadReleaseEntries('2.0.0', '0.0.0', releases).map((entry) => entry.version), ['2.0.0'])
  assert.deepEqual(getUnreadReleaseEntries('unknown', null, releases), [])
})

test('opening the current version clears unread notes and a downgrade does not resurrect them', () => {
  assert.deepEqual(getUnreadReleaseEntries('3.0.0', '3.0.0', releases), [])
  assert.deepEqual(getUnreadReleaseEntries('2.0.0', '3.0.0', releases), [])
})
