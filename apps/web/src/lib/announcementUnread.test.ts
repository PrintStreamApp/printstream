import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProductAnnouncement } from '@printstream/shared'
import { countUnreadAnnouncements, mergeReadAnnouncementSlugs, parseReadAnnouncementSlugs } from './announcementUnread'

const article = (slug: string): ProductAnnouncement => ({
  slug, title: slug, publishedOn: '2026-10-06', summary: slug,
  blocks: [{ type: 'paragraph', text: slug }]
})

test('newly fetched articles count as unread until the displayed catalog is marked read', () => {
  const announcements = [article('new'), article('old')]
  assert.equal(countUnreadAnnouncements(announcements, ['old']), 1)
  const read = mergeReadAnnouncementSlugs(['old', 'archived'], announcements)
  assert.equal(countUnreadAnnouncements(announcements, read), 0)
  assert.ok(read.includes('archived'))
  assert.equal(countUnreadAnnouncements([article('later'), ...announcements], read), 1)
})

test('invalid read markers cannot hide news and valid markers are deduplicated', () => {
  assert.equal(parseReadAnnouncementSlugs('{broken'), null)
  assert.equal(parseReadAnnouncementSlugs('["old",5]'), null)
  assert.deepEqual(parseReadAnnouncementSlugs('["old","old"]'), ['old'])
})
