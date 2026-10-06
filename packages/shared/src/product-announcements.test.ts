import assert from 'node:assert/strict'
import test from 'node:test'
import { findProductAnnouncement, getProductAnnouncementPath, parseProductAnnouncementsCatalog } from './product-announcements.js'

const article = {
  slug: 'printer-support',
  title: 'Printer support',
  publishedOn: '2026-10-06',
  summary: 'Upcoming printer support.',
  blocks: [{ type: 'paragraph', text: 'Support is coming soon.' }]
}

test('catalog order is newest first while URLs and lookup use stable slugs', () => {
  const catalog = parseProductAnnouncementsCatalog({
    featuredSlug: article.slug,
    announcements: [{ ...article, slug: 'older', publishedOn: '2026-09-01' }, article]
  })
  assert.deepEqual(catalog.announcements.map((entry) => entry.slug), ['printer-support', 'older'])
  assert.equal(getProductAnnouncementPath(article.slug), '/announcements/printer-support')
  assert.equal(findProductAnnouncement(article.slug, catalog.announcements)?.title, article.title)
  assert.equal(findProductAnnouncement('missing', catalog.announcements), undefined)
})

test('catalog rejects duplicate URLs, missing featured entries, unsafe slugs and impossible dates', () => {
  assert.throws(() => parseProductAnnouncementsCatalog({ featuredSlug: article.slug, announcements: [article, article] }))
  assert.throws(() => parseProductAnnouncementsCatalog({ featuredSlug: 'missing', announcements: [article] }))
  assert.throws(() => parseProductAnnouncementsCatalog({ featuredSlug: '../private', announcements: [{ ...article, slug: '../private' }] }))
  assert.throws(() => parseProductAnnouncementsCatalog({ featuredSlug: article.slug, announcements: [{ ...article, publishedOn: '2026-02-30' }] }))
})
