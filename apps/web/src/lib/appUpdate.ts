/**
 * Service-worker registration and update polling.
 *
 * Registers immediately, then asks the worker to re-check for a new build on a timer and
 * on every signal that the tab just came back to life. When workbox activates a new
 * worker it does NOT reload here: it hands off to `appStaleness.ts`, which owns the one
 * reload policy shared with the build-id detector, so an update can never discard unsaved
 * work. That handoff is the `onNeedReload` option; without it, vite-plugin-pwa reloads
 * the page itself, unconditionally, which is what this used to do.
 *
 * This is a best-effort detector, not the primary one. Every trigger below is dead while
 * an iOS home-screen app is suspended, and that can last weeks; the build-id comparison
 * in `appStaleness.ts` is what covers that case. Both exist because they fail
 * independently: the worker notices a new build with no server round trip, and the build
 * id notices one when the worker is not running at all.
 *
 * Do not reintroduce `onNeedRefresh` here. Under `registerType: 'autoUpdate'` (see
 * `vite.config.ts`) vite-plugin-pwa never calls it and `updateServiceWorker()` is a
 * no-op, so the previous version of this module documented and relied on a path that
 * could not run.
 */
import { registerSW } from 'virtual:pwa-register'
import { requestServiceWorkerReload } from './appStaleness'

const UPDATE_POLL_MS = 60 * 1000

let serviceWorkerRegistration: ServiceWorkerRegistration | null = null
let updateEventListenersRegistered = false

function checkForUpdates(): void {
  void serviceWorkerRegistration?.update()
}

/**
 * Ask the service worker to re-check for a new build now.
 *
 * Best-effort and fire-and-forget: it resolves against the network and does nothing
 * observable when there is no update or no registration. Call it from a path that smells
 * like stale code, such as a dynamic import that failed because its chunk is gone.
 */
export function checkForAppUpdate(): void {
  checkForUpdates()
}

export function registerAppServiceWorker(): void {
  if (typeof window === 'undefined') return

  registerSW({
    immediate: true,
    // Replaces vite-plugin-pwa's built-in `window.location.reload()`. Same trigger, but
    // routed through the busy gate.
    onNeedReload() {
      requestServiceWorkerReload()
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      serviceWorkerRegistration = registration
      checkForUpdates()

      if (updateEventListenersRegistered) return
      updateEventListenersRegistered = true

      window.setInterval(checkForUpdates, UPDATE_POLL_MS)
      window.addEventListener('focus', checkForUpdates)
      window.addEventListener('online', checkForUpdates)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdates()
      })
      // A restore from the back/forward cache runs no timers and fires neither `focus`
      // nor `visibilitychange` in some browsers, so it needs its own hook. This is the
      // closest thing to a resumed mobile app that reliably fires at all.
      window.addEventListener('pageshow', (event) => {
        if (event.persisted) checkForUpdates()
      })
    }
  })

  // A dynamic import whose chunk 404s means this bundle is referencing files the server
  // no longer has, i.e. a deploy landed under us. Nudge the worker rather than forcing a
  // reload: a genuine network failure looks identical from here, and there is no target
  // build to guard a reload loop against. The user-visible recovery is
  // `RouteErrorBoundary`; this just makes the next check happen now instead of within a
  // minute.
  window.addEventListener('vite:preloadError', () => {
    checkForAppUpdate()
  })
}
