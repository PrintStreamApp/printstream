/**
 * Pins the service worker's navigation policy.
 *
 * This exists because every bug this config has had was invisible in review. What decides
 * behaviour is the ORDER workbox registers routes in, which the config never states, so a
 * setting that reads as correct can silently make the route below it dead code. Two
 * separate options had to be turned off before a navigation to `/` actually reached the
 * network, and the second was found only by reading the generated `dist/sw.js`.
 *
 * Asserted against the real exported config, and the matcher is CALLED rather than
 * re-described, so the test cannot agree with a copy of the rules while the shipped
 * function says something else.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { workboxConfig } from '../../serviceWorkerConfig'

type NavigationMatcher = (context: { request: { mode: string }; url: URL }) => boolean

const appShellRoute = workboxConfig?.runtimeCaching?.[0]
const matches = (pathname: string, mode = 'navigate'): boolean => (
  (appShellRoute!.urlPattern as unknown as NavigationMatcher)({
    request: { mode },
    url: new URL(pathname, 'https://printstream.app')
  })
)

test('navigation fallbacks that would pre-empt the network route stay off', () => {
  // `navigateFallback` registers a precache-first NavigationRoute ahead of every runtime
  // route. `directoryIndex` is the subtler one: left at its 'index.html' default, workbox
  // rewrites a navigation to `/` into `/index.html`, which IS a precache entry, so `/`
  // alone stayed precache-first and unshiftable. Both must be off, or a client whose
  // update check never runs cannot reach a new build by any user action.
  assert.equal(workboxConfig?.navigateFallback, undefined)
  assert.equal(workboxConfig?.directoryIndex, null)
})

test('the app shell is served network-only with no runtime cache of its own', () => {
  // A runtime cache of navigations is worse than none: nothing prunes it, while precache
  // activation deletes the previous build's chunks, so a cached shell outlives the assets
  // it references and offline becomes a blank page on a route the user had visited.
  assert.equal(appShellRoute?.handler, 'NetworkOnly')
  assert.equal((appShellRoute?.options as { cacheName?: string } | undefined)?.cacheName, undefined)
})

test('offline falls back to the precached shell', () => {
  const options = appShellRoute?.options as {
    precacheFallback?: { fallbackURL?: string }
    networkTimeoutSeconds?: number
  } | undefined
  assert.equal(options?.precacheFallback?.fallbackURL, 'index.html')
  // Asserted as ABSENT rather than merely omitted: workbox-build hard-fails the build if
  // this is set alongside any handler but `NetworkFirst`, and `NetworkFirst` is exactly
  // the runtime cache this route must not have.
  assert.equal(options?.networkTimeoutSeconds, undefined)
})

test('the app shell route claims page navigations, including the root', () => {
  for (const pathname of ['/', '/workspaces', '/printers', '/library?folder=x', '/3mf-editor', '/pricing']) {
    assert.equal(matches(pathname), true, pathname)
  }
})

test('it never claims API or WebSocket paths', () => {
  for (const pathname of ['/api', '/api/', '/api/printers', '/ws', '/ws/']) {
    assert.equal(matches(pathname), false, pathname)
  }
  // Express routes case-insensitively, so these reach the API and must not be treated as
  // pages, or the worker would answer them with the app shell.
  assert.equal(matches('/API/printers'), false)
  assert.equal(matches('/WS'), false)
})

test('it does not claim non-navigation requests', () => {
  // Sub-resources must keep falling through to the precache and the network.
  assert.equal(matches('/assets/index-abc123.js', 'cors'), false)
  assert.equal(matches('/icon-192.png', 'no-cors'), false)
})

test('a path that merely starts with the letters api is still a page', () => {
  // `/apiary` is a page; only a real `/api` segment is excluded.
  assert.equal(matches('/apiary'), true)
  assert.equal(matches('/wsx'), true)
})
