/**
 * Service-worker registration + aggressive update logic.
 *
 * Mirrors `apps/web/src/lib/appUpdate.ts` from the game-is-up project
 * so both projects share the same proven update story:
 *
 * - `immediate: true` registers the SW as soon as the bundle loads.
 * - `onNeedRefresh` auto-applies the new SW (no user prompt) so a
 *   client running stale code never lingers behind a fresh deploy.
 * - The active registration polls for updates every 60s and whenever
 *   the tab regains focus, the network comes back, or the document
 *   becomes visible. This keeps long-lived PWA installs from drifting
 *   even if the user never closes the tab.
 *
 * PrintStream is a real-time printer dashboard — being even one deploy
 * behind can mean a stale `PrinterStatus` schema or a missing route
 * (e.g. plate thumbnails / library plates). Aggressive updates trade
 * a tiny bit of bandwidth for never debugging a stuck precache again.
 */
import { registerSW } from 'virtual:pwa-register'

let serviceWorkerRegistration: ServiceWorkerRegistration | null = null
let updateEventListenersRegistered = false

function checkForUpdates(): void {
  void serviceWorkerRegistration?.update()
}

/**
 * Manually trigger an update check. Call from settings UI or on
 * recovery from an error path that smells like stale code.
 */
export function checkForAppUpdate(): void {
  checkForUpdates()
}

export function registerAppServiceWorker(): void {
  if (typeof window === 'undefined') return

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      void updateServiceWorker(true)
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      serviceWorkerRegistration = registration
      checkForUpdates()

      if (updateEventListenersRegistered) return
      updateEventListenersRegistered = true

      window.setInterval(checkForUpdates, 60 * 1000)
      window.addEventListener('focus', checkForUpdates)
      window.addEventListener('online', checkForUpdates)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdates()
      })
    }
  })
}
