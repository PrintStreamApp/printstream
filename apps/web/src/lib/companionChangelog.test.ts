import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hasUnreadCompanionRelease
} from './companionChangelog'

test('only notes for the installed app version are unread', () => {
  const releases = [{ version: '1.2.3', releasedOn: '2026-09-13', changes: ['Added app release notes.'] }]
  assert.equal(hasUnreadCompanionRelease('1.2.3', null, releases), true)
  assert.equal(hasUnreadCompanionRelease('1.2.3', '1.2.3', releases), false)
  assert.equal(hasUnreadCompanionRelease('1.2.4', null, releases), false)
})
