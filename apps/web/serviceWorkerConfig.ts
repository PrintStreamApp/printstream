/**
 * How the service worker answers NAVIGATIONS, and why every option here is what it is.
 *
 * Extracted from `vite.config.ts` so it can be asserted on
 * (`src/lib/serviceWorkerRouting.test.ts`). It is worth that on its own: every mistake
 * this file has made was invisible in the source and only observable in the generated
 * `dist/sw.js`, because the thing that decides behaviour is the ORDER workbox registers
 * routes in, which nothing in the config states.
 *
 * The rule underneath all of it: a navigation must be able to reach the network, and the
 * only cached shell worth falling back to is the PRECACHED one. Precache-first
 * navigations pin a client to a build that no user action can shift, which on an iOS
 * home-screen app (no hard refresh, no devtools) leaves deleting and re-adding the app as
 * the only cure. Any runtime cache of navigations is worse than none, because nothing
 * prunes it: `cleanupOutdatedCaches` only deletes caches whose name contains `-precache-`,
 * while precache activation deletes the previous build's chunks, so a runtime-cached shell
 * outlives the assets it references and offline becomes a blank page.
 *
 * Counterpart: `src/lib/appStaleness.ts`, whose reload only does anything because
 * navigations are network-first here.
 */
import type { VitePWAOptions } from 'vite-plugin-pwa'

type WorkboxOptions = Partial<VitePWAOptions>['workbox']

export const workboxConfig: WorkboxOptions = {
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
  // The OpenCASCADE build is ~7.6 MB and is only reached when someone imports a STEP file
  // in the 3MF editor. Precaching it would make every install pay that download up front
  // (and trip the size limit above, which fails the build); it is fetched on demand.
  globIgnores: ['**/occt-import-js*.wasm'],
  // OFF, and it must stay off. vite-plugin-pwa defaults it to `index.html`, which
  // registers a precache-first NavigationRoute BEFORE any `runtimeCaching` entry. Workbox
  // takes the first matching route, so leaving it set silently turns the route below into
  // dead code.
  navigateFallback: undefined,
  // Also off, for the same reason one level down, and this one is subtler. Precaching
  // registers ahead of every runtime route, and with the default
  // `directoryIndex: 'index.html'` workbox rewrites a navigation to `/` into
  // `/index.html`, which IS a precache entry. So `/` alone stayed precache-first even with
  // `navigateFallback` off: the landing page, and the manifest `id`, was the one path the
  // fix did not reach.
  directoryIndex: null,
  runtimeCaching: [{
    // Workbox serializes this with `.toString()` and evaluates it inside the worker, so it
    // must be entirely SELF-CONTAINED: a reference to any module-scope constant compiles
    // fine here and is a ReferenceError in the browser. Hence the inline literals. The
    // exclusions mirror what used to live in `navigateFallbackDenylist`, and are
    // case-insensitive because Express routes case-insensitively, so `/API/...` reaches
    // the API and must not be treated as a page. `serviceWorkerRouting.test.ts` calls this
    // exact function rather than a copy of its rules.
    urlPattern: ({ request, url }) => request.mode === 'navigate'
      && !/^\/api(?:\/|$)/i.test(url.pathname)
      && !/^\/ws(?:\/|$)/i.test(url.pathname),
    // `NetworkOnly`, not `NetworkFirst`, so there is no runtime cache to go stale (see the
    // module header). The fallback below is what keeps offline working.
    handler: 'NetworkOnly',
    options: {
      // NO `networkTimeoutSeconds`, and it cannot be added: workbox-build hard-fails the
      // build unless the handler is `NetworkFirst`, and `NetworkFirst` is what reintroduces
      // the stale runtime cache. Its timeout would not help regardless, because it resolves
      // to whatever is in that cache and falls through to the full fetch on a miss.
      //
      // The accepted cost: a NAVIGATION on a barely-alive connection now waits for the
      // browser's own fetch timeout, where precache-first painted instantly. Offline is
      // unaffected (the fetch rejects at once and the fallback is immediate), and the SPA
      // only navigates on a cold launch, so this is the first paint on bad wifi, not
      // ongoing use. Taken deliberately: the alternative is a client that cannot be
      // updated by any means, which is the bug this whole change exists to fix.
      //
      // The precached `index.html` is the only shell guaranteed to match the precached
      // assets. Serving it also IMPROVES the previous behaviour: a deep link never visited
      // offline now resolves to the app instead of failing.
      precacheFallback: { fallbackURL: 'index.html' },
      plugins: [{
        // A 5xx resolves like any other response, so without this a mid-deploy 502 would
        // paint the proxy's error page where the app shell belongs.
        fetchDidSucceed: async ({ response }: { response: Response }) => {
          if (response.ok) return response
          throw new Error(`Navigation request failed with ${response.status}`)
        }
      }]
    }
  }],
  skipWaiting: true,
  // Pulled in verbatim by the generated service worker. Adds the `push` and
  // `notificationclick` listeners used by the notifications-browser plugin.
  importScripts: ['/push-handler.js']
}
