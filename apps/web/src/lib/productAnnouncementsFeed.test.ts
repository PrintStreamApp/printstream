import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { announcementArticleUrl, fetchAnnouncementsFeed, readCachedAnnouncements } from './productAnnouncementsFeed'

const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const saved = new Map<string, string>()
const feedUrl = 'https://printstream.app/announcements.json'
const catalog = {
  featuredSlug: 'news',
  announcements: [{
    slug: 'news', title: 'News', publishedOn: '2026-10-06', summary: 'News summary.',
    blocks: [{ type: 'paragraph', text: 'News content.' }]
  }]
}

beforeEach(() => {
  saved.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

test('only a successful credential-free fetch creates the cached catalog, separated by feed source', async () => {
  assert.equal(readCachedAnnouncements(feedUrl), undefined)
  globalThis.fetch = async (_input, options) => {
    assert.equal(options?.credentials, 'omit')
    assert.equal(options?.referrerPolicy, 'no-referrer')
    assert.ok(options?.signal)
    return Response.json(catalog)
  }
  const fetched = await fetchAnnouncementsFeed(feedUrl, new AbortController().signal)
  assert.deepEqual(readCachedAnnouncements(feedUrl), fetched)
  assert.equal(readCachedAnnouncements('https://staging.printstream.app/announcements.json'), undefined)
})

test('permalinks follow the feed host instead of sending unpublished staging news to production', () => {
  assert.equal(announcementArticleUrl('/announcements.json', 'news', 'https://staging.printstream.app/workspaces/default/jobs'),
    'https://staging.printstream.app/announcements/news')
  assert.equal(announcementArticleUrl(feedUrl, 'news', 'http://local-printer.local/jobs'),
    'https://printstream.app/announcements/news')
})

test('HTTP, network and invalid-feed failures retain the last successful fetch', async () => {
  globalThis.fetch = async () => Response.json(catalog)
  const fetched = await fetchAnnouncementsFeed(feedUrl, new AbortController().signal)

  for (const response of [new Response('', { status: 503 }), Response.json({ announcements: [] })]) {
    globalThis.fetch = async () => response
    await assert.rejects(fetchAnnouncementsFeed(feedUrl, new AbortController().signal))
    assert.deepEqual(readCachedAnnouncements(feedUrl), fetched)
  }
  globalThis.fetch = async () => { throw new TypeError('Offline') }
  await assert.rejects(fetchAnnouncementsFeed(feedUrl, new AbortController().signal))
  assert.deepEqual(readCachedAnnouncements(feedUrl), fetched)
})

test('cancelled requests cannot populate the cache, even if a transport returns late', async () => {
  const controller = new AbortController()
  globalThis.fetch = async (_input, options) => {
    controller.abort()
    assert.equal(options?.signal?.aborted, true)
    return Response.json(catalog)
  }
  await assert.rejects(fetchAnnouncementsFeed(feedUrl, controller.signal))
  assert.equal(readCachedAnnouncements(feedUrl), undefined)
})

test('a stalled feed is aborted after the bounded timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = async (_input, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  })
  const pending = fetchAnnouncementsFeed(feedUrl, new AbortController().signal)
  context.mock.timers.tick(10_000)
  await assert.rejects(pending, /timed out/)
  assert.equal(readCachedAnnouncements(feedUrl), undefined)
})

test('corrupt cache and unavailable storage do not prevent fetching fresh news', async () => {
  saved.set(`printstream.announcements.lastFetch:${feedUrl}`, '{broken')
  assert.equal(readCachedAnnouncements(feedUrl), undefined)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => { throw new Error('Storage disabled') }
  })
  globalThis.fetch = async () => Response.json(catalog)
  const fetched = await fetchAnnouncementsFeed(feedUrl, new AbortController().signal)
  assert.equal(fetched.catalog.announcements[0]?.title, 'News')
})
