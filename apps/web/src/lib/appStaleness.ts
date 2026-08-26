/**
 * Gets a tab that is running an old build onto the current one, safely.
 *
 * Owns the RELOAD POLICY. Two detectors feed it and neither decides anything itself:
 *  - `observeServedWebBuildId`, from the build id the server reports on the WS `hello`
 *    frame and the `X-PrintStream-Web-Build` response header (`webBuildId.ts`);
 *  - `requestServiceWorkerReload`, from workbox activating a new worker (`appUpdate.ts`).
 *
 * Why a second detector at all: the service worker used to be the only one, and it is
 * the one that fails on a suspended phone. Its update check runs on a timer and on
 * focus/online/visibilitychange, all of which are dead while an iOS home-screen app sits
 * suspended, sometimes for weeks. A resumed app dials a new WebSocket and makes API
 * calls no matter what, so the build id arrives without depending on any of that.
 *
 * Three rules this module exists to enforce, all learned the hard way:
 *
 * **A reload must not eat work in flight.** The previous behaviour was an unconditional
 * `window.location.reload()` on worker activation, which would discard an unsaved 3MF
 * project mid-edit. A scripted reload does not trigger the editor's `beforeunload`
 * guard, and mobile Safari ignores that dialog anyway, so nothing else would have caught
 * it. `appBusy.ts` gates it; while busy the user gets a notice and the reload lands the
 * moment the work finishes.
 *
 * **A reported id is a hint, not a fact.** Both channels can deliver a value that was
 * true when it was issued and is not true now: a response header can be replayed out of
 * the browser's HTTP cache hours later, and several `/api` routes are deliberately
 * cacheable. Since a build id is an unordered hash, a replayed OLD id is indistinguishable
 * from a genuine NEW one, so every mismatch is confirmed against an uncacheable probe
 * before anything happens.
 *
 * **A reload must not be able to loop.** If the tab reloads and comes back still stale,
 * reloading again would spin every client at once. One automatic attempt per target
 * build, recorded in `sessionStorage`; after that it is a button the user presses. The
 * automatic path therefore refuses to go at all when it cannot WRITE that record, since an
 * unrecorded reload is an unguarded one, and storage throws in real configurations
 * (Safari's "Block all cookies", some private modes) rather than hypothetical ones. The
 * recovery deliberately stops at reloading and never unregisters the worker or clears
 * caches: that would drop the push subscription bound to the registration, and it cannot
 * help anyway, since the only realistic way a reload fails to land is a network too slow
 * for the navigation fetch, which nuking local state does not fix.
 *
 * That guard is per-TARGET, which is sufficient only because one node serves both the
 * bundle and `/api`. Revisit it before running a second API replica: two replicas on
 * different builds would answer alternately, each answer would look like a fresh target,
 * and the per-target record would never trip. A per-session attempt COUNTER is the shape
 * that survives that, at the cost of giving up after N updates in one session.
 */
import { isAppBusy, subscribeAppBusy } from './appBusy'
import { toast } from './toast'
import { readLocalWebBuildId } from './webBuildId'

/** Records the build a reload was aimed at, so a failed attempt cannot be repeated blindly. */
const RELOAD_ATTEMPT_KEY = 'printstream:stale-reload-target'

/**
 * Written next to the bundle by `apps/web/webBuildIdPlugin.ts`, and re-read to CONFIRM a
 * mismatch before acting on it.
 *
 * The reported id cannot be trusted on its own, because a response header can be replayed
 * out of the browser's HTTP cache long after it was issued: several `/api` routes are
 * deliberately cacheable (`routes/public-slicing.ts` serves the catalogue as
 * `public, max-age=3600`) and they are fetched through `apiFetch` like everything else.
 * A build id is an unordered hash, so a replayed OLD id is indistinguishable from a
 * genuine NEW one, and a current tab would reload itself over a stale cache entry, land
 * back on the build it started from, and then be stuck showing the "could not switch
 * automatically" notice for the rest of the session.
 *
 * This probe is fetched `no-store`, so it always describes what is being served right
 * now, and it is the file the served bundle's own meta tag was generated from.
 */
const BUILD_ID_PROBE_PATH = '/build-id.json'

/**
 * How long the app must stay continuously idle before a pending reload fires. Without
 * it, a reload can land in the gap between two steps of one user action (an upload
 * finishing and the next starting), which reads as a random refresh.
 */
const IDLE_SETTLE_MS = 1_500

let targetBuildId: string | null = null
let stopWatchingIdle: (() => void) | null = null
let idleTimer: number | null = null
let noticeToastId: number | null = null
/** The candidate currently being confirmed, so a burst of API responses probes once. */
let confirmingBuildId: string | null = null

/**
 * Swallow exactly ONE service-worker reload, because this page load is already the
 * result of one.
 *
 * After a build-id reload the worker still has its own update to apply, and activating it
 * would otherwise fire a second, visible refresh onto the bundle this tab is already
 * running. One-shot on purpose: a later activation in the same page load is a genuinely
 * new deploy. Do NOT widen this to "the ids currently agree" — the worker is the ONLY
 * detector for a deploy that changes `index.html` or a `public/` file, neither of which
 * moves the build id, and that test would silence it for exactly those.
 */
let suppressNextServiceWorkerReload = false

/**
 * How the tab actually navigates.
 *
 * Indirected purely so tests can observe the decision: jsdom refuses to let
 * `location.reload` be replaced on either the instance or the prototype, and "did it
 * decide to reload, and when" is the entire behaviour of this module. Production never
 * reassigns it.
 */
let reloadPage: () => void = () => {
  window.location.reload()
}

function readReloadAttempt(): string | null {
  // Storage can be unavailable (disabled cookies, some private modes). Losing the guard
  // is worse than losing the feature, so an unreadable store means we never auto-reload.
  try {
    return window.sessionStorage.getItem(RELOAD_ATTEMPT_KEY)
  } catch {
    return null
  }
}

function writeReloadAttempt(buildId: string | null): boolean {
  try {
    if (buildId === null) window.sessionStorage.removeItem(RELOAD_ATTEMPT_KEY)
    else window.sessionStorage.setItem(RELOAD_ATTEMPT_KEY, buildId)
    return true
  } catch {
    return false
  }
}

/**
 * Clears the attempt record when this load IS the build the last reload aimed at.
 *
 * Runs once at import. Without it the guard would be a one-shot per session: a
 * successful update would leave its own target recorded and block the next one.
 */
function clearLandedReloadAttempt(): void {
  const attempted = readReloadAttempt()
  if (!attempted || attempted !== readLocalWebBuildId()) return
  writeReloadAttempt(null)
  // This load IS the reload's destination, so the worker's own pending activation is
  // redundant. See `suppressNextServiceWorkerReload`.
  suppressNextServiceWorkerReload = true
}

function cancelPendingUpdate(): void {
  targetBuildId = null
  stopWatchingIdle?.()
  stopWatchingIdle = null
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer)
    idleTimer = null
  }
  if (noticeToastId !== null) {
    toast.dismiss(noticeToastId)
    noticeToastId = null
  }
}

/**
 * Tell the user an update is waiting.
 *
 * `manualOnly` means nothing will happen without them: either the automatic path is
 * refusing to retry, or it cannot make itself safe. That notice is the ONLY one carrying a
 * button. The deferred notice deliberately has none, because it promises to wait for the
 * work in flight, and the toast stack renders above the modal layer (and at the TOP of a
 * phone screen), so a "Reload now" beside that sentence is a single mis-tap that discards
 * the very unsaved project the message just promised to protect.
 */
function showUpdateNotice(manualOnly: boolean): void {
  if (noticeToastId !== null) return
  noticeToastId = toast.show({
    message: manualOnly
      ? 'A new version of PrintStream is ready, but this tab could not switch to it automatically.'
      : 'A new version of PrintStream is ready. It will load once your current work finishes.',
    tone: manualOnly ? 'warning' : 'neutral',
    durationMs: 0,
    ...(manualOnly ? { action: { label: 'Reload now', onClick: () => reloadPage() } } : {}),
    // Without this the id outlives the toast, and since `showUpdateNotice` early-returns
    // while it is set, a user dismissing the warning (or any `toast.clear()`, which a
    // workspace switch performs) would permanently silence the only signal the manual-only
    // branch has. That branch arms no idle watcher, so there would be nothing left at all.
    onClose: () => { noticeToastId = null }
  })
}

/**
 * Reload automatically, but only if the attempt can be RECORDED first.
 *
 * A write that fails means the loop guard cannot work on the next load, and an unguarded
 * automatic reload is the fleet-wide spin this module exists to prevent. Storage throws in
 * real configurations, not hypothetical ones (Safari's "Block all cookies", some private
 * modes), so this falls back to asking rather than reloading blind.
 */
function reloadNowIfRecordable(buildId: string | null): void {
  if (buildId && !writeReloadAttempt(buildId)) {
    showUpdateNotice(true)
    return
  }
  reloadPage()
}

function watchForIdle(): void {
  if (stopWatchingIdle) return
  const evaluate = (): void => {
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer)
      idleTimer = null
    }
    if (isAppBusy()) return
    idleTimer = window.setTimeout(() => {
      idleTimer = null
      if (isAppBusy()) return
      reloadNowIfRecordable(targetBuildId)
    }, IDLE_SETTLE_MS)
  }
  stopWatchingIdle = subscribeAppBusy(evaluate)
  evaluate()
}

/** Start moving this tab onto `buildId`, now or as soon as it is safe. */
function beginUpdate(buildId: string | null): void {
  if (buildId && readReloadAttempt() === buildId) {
    // Already reloaded once for this exact build and came back still on the old one.
    // Something upstream is answering with stale HTML; another reload would loop.
    showUpdateNotice(true)
    return
  }
  if (!isAppBusy()) {
    reloadNowIfRecordable(buildId)
    return
  }
  showUpdateNotice(false)
  watchForIdle()
}

/**
 * Compare the build the server says it is serving against the one this tab is running.
 *
 * Called on every WS hello and every API response, so it is cheap and idempotent. A null
 * or absent `servedBuildId` means the server does not know what it serves (split
 * topology, or a bundle predating the build stamp) and is never treated as staleness;
 * likewise a tab with no id of its own, which is every dev build.
 */
export function observeServedWebBuildId(servedBuildId: string | null | undefined): void {
  if (!servedBuildId) return
  const localBuildId = readLocalWebBuildId()
  if (!localBuildId) return
  if (localBuildId === servedBuildId) {
    // Back in agreement. Covers a rollback: the deploy this tab was told to move to is
    // gone, and it is already running what the server now serves.
    if (targetBuildId !== null) cancelPendingUpdate()
    return
  }
  if (targetBuildId === servedBuildId || confirmingBuildId === servedBuildId) return
  void confirmThenBeginUpdate(servedBuildId)
}

/**
 * Re-ask the server directly before acting on a reported mismatch.
 *
 * A reported id is only a HINT, because the response that carried it may have come out of
 * the browser's HTTP cache rather than from the server just now (see
 * {@link BUILD_ID_PROBE_PATH}). Acting on it directly meant a fully up-to-date tab could
 * reload itself over an hour-old cached header and then wear the "could not switch
 * automatically" warning for the rest of the session.
 *
 * Failure is silence: an unreachable or unreadable probe leaves the tab alone, because
 * this must never be the reason someone's page reloads.
 */
async function confirmThenBeginUpdate(candidateBuildId: string): Promise<void> {
  confirmingBuildId = candidateBuildId
  try {
    const servedBuildId = await probeServedWebBuildId()
    const localBuildId = readLocalWebBuildId()
    if (!servedBuildId || !localBuildId || servedBuildId === localBuildId) return
    if (targetBuildId === servedBuildId) return
    cancelPendingUpdate()
    targetBuildId = servedBuildId
    beginUpdate(servedBuildId)
  } finally {
    confirmingBuildId = null
  }
}

/** The build the server is serving right now, straight from disk, or null if unknown. */
async function probeServedWebBuildId(): Promise<string | null> {
  try {
    const response = await fetch(BUILD_ID_PROBE_PATH, { cache: 'no-store', credentials: 'omit' })
    if (!response.ok) return null
    const body = await response.json() as { buildId?: unknown }
    return typeof body.buildId === 'string' ? body.buildId.trim() || null : null
  } catch {
    return null
  }
}

/**
 * The service worker activated a new build under this tab.
 *
 * No target id: workbox reports that it swapped, not what it swapped to. There is no loop
 * to guard against, because a worker activates once per update.
 *
 * This is NOT redundant with the build-id detector. It is the only thing that notices a
 * deploy which changed `index.html` or a file in `public/`, since neither is part of the
 * bundle the id is derived from. The single case worth swallowing is handled by
 * {@link suppressNextServiceWorkerReload}.
 */
export function requestServiceWorkerReload(): void {
  if (targetBuildId !== null) return
  if (suppressNextServiceWorkerReload) {
    suppressNextServiceWorkerReload = false
    return
  }
  beginUpdate(null)
}

/** Test seam: drop all pending state (does not touch `sessionStorage`). */
export function resetAppStalenessForTests(): void {
  cancelPendingUpdate()
  confirmingBuildId = null
  suppressNextServiceWorkerReload = false
}

/** Test seam: observe the reload decision. See {@link reloadPage}. */
export function setReloadPageForTests(next: () => void): void {
  reloadPage = next
}

clearLandedReloadAttempt()
