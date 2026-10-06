import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { fetchAnnouncementsFeed } from '../lib/productAnnouncementsFeed'

let dom: JSDOM
let createElement: typeof import('react').createElement
let render: typeof import('@testing-library/react').render
let cleanup: typeof import('@testing-library/react').cleanup
let waitFor: typeof import('@testing-library/react').waitFor
let fireEvent: typeof import('@testing-library/react').fireEvent
let QueryClient: typeof import('@tanstack/react-query').QueryClient
let QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider
let ProductAnnouncementsDialog: typeof import('./ProductAnnouncementsDialog').ProductAnnouncementsDialog
let FooterAnnouncements: typeof import('./FooterAnnouncements').FooterAnnouncements
const originalFetch = globalThis.fetch
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const feedUrl = 'https://printstream.app/announcements.json'
const feed = {
  featuredSlug: 'online-news',
  announcements: [{
    slug: 'online-news', title: 'News supplied by the feed', publishedOn: '2026-10-06',
    summary: 'A feed-only entry.', blocks: [{ type: 'paragraph', text: 'This entry came from the server.' }]
  }]
}

before(async () => {
  dom = installJsdomGlobals()
  dom.window.requestAnimationFrame = (callback) => dom.window.setTimeout(() => callback(Date.now()), 0)
  dom.window.cancelAnimationFrame = (handle) => dom.window.clearTimeout(handle)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
  createElement = (await import('react')).createElement
  const testing = await import('@testing-library/react')
  render = testing.render
  cleanup = testing.cleanup
  waitFor = testing.waitFor
  fireEvent = testing.fireEvent
  const query = await import('@tanstack/react-query')
  QueryClient = query.QueryClient
  QueryClientProvider = query.QueryClientProvider
  ProductAnnouncementsDialog = (await import('./ProductAnnouncementsDialog')).ProductAnnouncementsDialog
  FooterAnnouncements = (await import('./FooterAnnouncements')).FooterAnnouncements
})

afterEach(() => {
  cleanup()
  dom.window.localStorage.clear()
  globalThis.fetch = originalFetch
})

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else Reflect.deleteProperty(globalThis, 'localStorage')
  dom.window.close()
})

/** Each opening gets a fresh query client so the offline cases exercise persisted cache only. */
function openDialog(onClose = () => undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(QueryClientProvider, { client },
    createElement(ProductAnnouncementsDialog, { feedUrl, onClose })
  ))
}

test('renders online feed content and its permanent article link, with Escape dismissal', async () => {
  globalThis.fetch = async () => Response.json(feed)
  let closed = 0
  const view = openDialog(() => { closed += 1 })
  await waitFor(() => assert.ok(view.getByText('This entry came from the server.')))
  assert.equal(view.getByRole('link', { name: 'Open article' }).getAttribute('href'),
    'https://printstream.app/announcements/online-news')
  const close = view.getByRole('button', { name: 'Close' })
  assert.equal(dom.window.document.activeElement, close)
  close.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(closed, 1)
})

test('offline with no cache shows Retry and no bundled article', async () => {
  globalThis.fetch = async () => { throw new TypeError('Offline') }
  const view = openDialog()
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'Retry' })))
  assert.ok(view.getByText(/Announcements need an internet connection/))
  assert.equal(view.queryAllByRole('article').length, 0)
})

test('offline refresh labels the last successful fetch and keeps its article visible', async () => {
  globalThis.fetch = async () => Response.json(feed)
  await fetchAnnouncementsFeed(feedUrl, new AbortController().signal)
  globalThis.fetch = async () => { throw new TypeError('Offline') }
  const view = openDialog()
  await waitFor(() => assert.ok(view.getByText(/Showing the last saved copy/)))
  assert.ok(view.getByText('This entry came from the server.'))
})

test('footer discovers news before opening, clears read counts and counts newly fetched articles', async () => {
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return Response.json(feed) }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const view = render(createElement(QueryClientProvider, { client },
    createElement(FooterAnnouncements, { deployment: 'self-hosted' })
  ))
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View announcements, 1 unread' })))
  assert.equal(requests, 1)
  const footerButton = view.getByRole('button', { name: 'View announcements, 1 unread' })
  fireEvent.click(footerButton)
  await waitFor(() => assert.ok(view.getByText('This entry came from the server.')))
  // The modal correctly hides the underlying footer from accessibility queries while open.
  await waitFor(() => assert.equal(footerButton.getAttribute('aria-label'), 'View announcements'))
  fireEvent.click(view.getByRole('button', { name: 'Close' }))
  await waitFor(() => assert.equal(view.queryByRole('dialog'), null))

  const nextArticle = { ...feed.announcements[0], slug: 'newer-news', title: 'Newer news' }
  globalThis.fetch = async () => Response.json({ ...feed, announcements: [nextArticle, ...feed.announcements] })
  await client.refetchQueries({ queryKey: ['product-announcements', feedUrl] })
  await waitFor(() => assert.ok(view.getByRole('button', { name: 'View announcements, 1 unread' })))

  globalThis.fetch = async () => { throw new TypeError('Offline') }
  await client.refetchQueries({ queryKey: ['product-announcements', feedUrl] })
  assert.ok(view.getByRole('button', { name: 'View announcements, 1 unread' }))
  cleanup()
  client.clear()
})

test('footer checks hourly while active and skips background checks', async (context) => {
  const { focusManager } = await import('@tanstack/react-query')
  context.mock.timers.enable({ apis: ['setInterval'] })
  focusManager.setFocused(true)
  let requests = 0
  globalThis.fetch = async () => { requests += 1; return Response.json(feed) }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  try {
    render(createElement(QueryClientProvider, { client },
      createElement(FooterAnnouncements, { deployment: 'self-hosted' })
    ))
    await waitFor(() => assert.equal(client.isFetching(), 0))
    assert.equal(requests, 1)
    context.mock.timers.tick(60 * 60_000 - 1)
    assert.equal(requests, 1)
    context.mock.timers.tick(1)
    await waitFor(() => assert.equal(requests, 2))
    await waitFor(() => assert.equal(client.isFetching(), 0))

    focusManager.setFocused(false)
    context.mock.timers.tick(60 * 60_000)
    assert.equal(requests, 2)
    focusManager.setFocused(true)
    await waitFor(() => assert.equal(client.isFetching(), 0))
    assert.equal(requests, 2)
    context.mock.timers.tick(60 * 60_000)
    await waitFor(() => assert.equal(requests, 3))
  } finally {
    cleanup()
    client.clear()
    focusManager.setFocused(undefined)
  }
})
