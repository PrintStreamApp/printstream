/**
 * A stable id for THIS browser tab.
 *
 * Backed by `sessionStorage`, which is exactly the scope wanted: unique per tab, and it survives a
 * reload or an in-tab navigation. (A duplicated tab inherits the id — a rare edge the consumers
 * below tolerate, and the only alternative would not survive a reload.)
 *
 * Used to give a slicing job an owning tab: only the owning tab shows its progress toast, and the
 * API cancels the job once that tab has gone. The same id rides the `/ws` connection as `client`,
 * which is how the server knows the tab is still there — counterpart:
 * `apps/api/src/lib/client-sessions.ts`.
 */
import { buildApiUrl } from './apiUrl'

const TAB_SESSION_KEY = 'printstream.tabSessionId'

/**
 * Falls back to a per-page-load id when `sessionStorage` is unavailable (private modes, embedded
 * webviews, SSR). That is strictly weaker — a reload then reads as a new tab — so it degrades to
 * "the toast disappears and the slice is cancelled on reload" rather than to a crash.
 */
let fallbackId: string | null = null

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function readTabSessionId(): string {
  if (typeof window === 'undefined') {
    fallbackId ??= createId()
    return fallbackId
  }
  try {
    const existing = window.sessionStorage.getItem(TAB_SESSION_KEY)
    if (existing) return existing
    const created = createId()
    window.sessionStorage.setItem(TAB_SESSION_KEY, created)
    return created
  } catch {
    fallbackId ??= createId()
    return fallbackId
  }
}

/**
 * Tell the API this tab's document is going away, so its running slices are reaped NOW rather than
 * after the socket grace. Covers closing the tab and reloading it alike: both drop the user out of
 * the editor and the slice dialog, and an editor slice is persisted hidden from the library with no
 * action on its toast — so letting it finish yields a file the user cannot reach while holding a
 * slicer the next job wants.
 *
 * `sendBeacon` because an unload handler cannot await a fetch; the request is queued by the browser
 * and outlives the page. It is best-effort by construction (a killed tab, a full beacon queue, a
 * browser that drops it), which is why the server keeps the grace as its backstop rather than
 * relying on this.
 *
 * Bound to `pagehide`, not `beforeunload`: `beforeunload` is unreliable on mobile Safari and blocks
 * the bfcache. A bfcache eviction (`persisted: true`) is deliberately NOT reported — that page can
 * come back, and cancelling a slice for a back-swipe would be a false positive of the exact kind
 * the grace exists to avoid.
 */
export function reportTabLeaving(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  const body = new Blob([JSON.stringify({ client: readTabSessionId() })], { type: 'application/json' })
  try {
    navigator.sendBeacon?.(buildApiUrl('/api/slicing/jobs/leaving'), body)
  } catch {
    // Unload is not a place to surface anything; the server's grace covers the miss.
  }
}
