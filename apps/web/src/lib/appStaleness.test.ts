/**
 * The reload policy: when a tab running an old build is allowed to jump onto a new one.
 *
 * The rules worth regression-testing are the ones whose failure modes are ugly and silent:
 * reloading over work in flight destroys it with nothing to catch the loss, reloading
 * toward a build that never arrives spins every client in the fleet at once, and acting on
 * a build id replayed from the HTTP cache reloads a tab that was already current.
 */
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

type StalenessModule = typeof import('./appStaleness')
type BusyModule = typeof import('./appBusy')
type BuildIdModule = typeof import('./webBuildId')
type ToastModule = typeof import('./toast')

let dom: JSDOM
let staleness: StalenessModule
let busy: BusyModule
let buildId: BuildIdModule
let toastModule: ToastModule
let reloads: number

/**
 * What `/build-id.json` answers. This is the authoritative channel: a reported id is only
 * a hint until this confirms it, so most tests stage the two independently.
 */
let probedBuildId: string | null = 'build-new'
let probeCalls: number

/** The build id this tab is pretending to run, restaged before each test. */
function setLocalBuildId(value: string | null): void {
  const existing = document.querySelector(`meta[name="${buildId.WEB_BUILD_ID_META_NAME}"]`)
  existing?.remove()
  if (value !== null) {
    const meta = document.createElement('meta')
    meta.setAttribute('name', buildId.WEB_BUILD_ID_META_NAME)
    meta.setAttribute('content', value)
    document.head.append(meta)
  }
  buildId.resetLocalWebBuildIdForTests()
}

/** Let the confirmation probe and any follow-up microtasks settle. */
async function settleProbe(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

before(async () => {
  // jsdom first: the module clears a landed reload record at import time.
  dom = installJsdomGlobals()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!url.includes('build-id.json')) throw new Error(`unexpected fetch: ${url}`)
    probeCalls += 1
    if (probedBuildId === null) throw new Error('probe unreachable')
    return {
      ok: true,
      json: async () => ({ buildId: probedBuildId })
    } as Response
  }) as typeof fetch
  buildId = await import('./webBuildId')
  busy = await import('./appBusy')
  toastModule = await import('./toast')
  staleness = await import('./appStaleness')
  staleness.setReloadPageForTests(() => { reloads += 1 })
})

after(() => { dom.window.close() })

beforeEach(() => {
  reloads = 0
  probeCalls = 0
  probedBuildId = 'build-new'
  window.sessionStorage.clear()
  busy.resetAppBusyForTests()
  staleness.resetAppStalenessForTests()
  toastModule.toast.clear()
  setLocalBuildId('build-old')
})

test('stays put when the server is serving the build this tab is running', async () => {
  staleness.observeServedWebBuildId('build-old')
  await settleProbe()
  assert.equal(reloads, 0)
  assert.equal(probeCalls, 0, 'agreement needs no probe')
})

test('stays put when the server does not know what it is serving', async () => {
  // Split topology, or a bundle built before the build stamp existed. Unknown is never
  // "you are stale" - the whole scheme depends on that asymmetry.
  staleness.observeServedWebBuildId(null)
  staleness.observeServedWebBuildId(undefined)
  staleness.observeServedWebBuildId('')
  await settleProbe()
  assert.equal(reloads, 0)
})

test('stays put when this build carries no id of its own', async () => {
  // Every dev build. Without this guard a dev tab would reload on every API call.
  setLocalBuildId(null)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0)
})

test('reloads when the mismatch is confirmed and nothing is in flight', async () => {
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 1)
})

test('the startup preflight finds a new served build without waiting for a hint', async () => {
  await staleness.checkForServedWebUpdate()

  assert.equal(probeCalls, 1)
  assert.equal(reloads, 1)
})

test('the startup preflight leaves a current tab alone', async () => {
  probedBuildId = 'build-old'
  await staleness.checkForServedWebUpdate()

  assert.equal(probeCalls, 1)
  assert.equal(reloads, 0)
})

test('ignores a build id replayed from the HTTP cache', async () => {
  // Several /api routes are `public, max-age=3600`, so a cached response can carry an id
  // from an hour ago. Ids are unordered hashes, so an OLD id looks exactly like a NEW one.
  // Acting on it reloads a current tab and then strands it on the "could not switch"
  // warning, because the reload lands on the build it started from.
  setLocalBuildId('build-current')
  probedBuildId = 'build-current'
  staleness.observeServedWebBuildId('build-stale-from-cache')
  await settleProbe()
  assert.equal(probeCalls, 1, 'the mismatch should be confirmed, not trusted')
  assert.equal(reloads, 0, 'the server is serving what this tab already runs')
})

test('does nothing when the confirmation probe cannot be reached', async () => {
  // Failure must never be the reason a page reloads.
  probedBuildId = null
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0)
})

test('a burst of reports confirms once and reloads once', async () => {
  // Every API response calls in, so the entry point has to be idempotent AND must not
  // fire a probe per response.
  staleness.observeServedWebBuildId('build-new')
  staleness.observeServedWebBuildId('build-new')
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(probeCalls, 1)
  assert.equal(reloads, 1)
})

test('holds the reload while work is in flight, and takes it once the work finishes', async () => {
  busy.setAppBusy('editor-edits', true)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0, 'must not reload over unsaved work')
  assert.equal(staleness.isWebUpdatePending(), true)

  // `subscribe` replays the current entries synchronously, so this reads them and leaves
  // no listener behind to fire during the next test's cleanup.
  let notices: readonly { message: string }[] = []
  toastModule.toast.subscribe((entries) => { notices = entries })()
  assert.equal(notices.length, 1, 'the user should be told an update is waiting')
  assert.match(notices[0]!.message, /new version/i)

  busy.setAppBusy('editor-edits', false)
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(reloads, 1)
})

test('an open dialog holds the reload like any other work in flight', async () => {
  busy.setAppBusy('dialog-open', true)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0)
})

test('work that starts again during the settle delay keeps holding the reload', async () => {
  busy.setAppBusy('library-uploads', true)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  busy.setAppBusy('library-uploads', false)
  busy.setAppBusy('slicing', true)
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(reloads, 0)
})

test('does not auto-reload a second time toward a build that never arrived', async () => {
  // The loop guard. A reload that lands on the new build clears this record; one that
  // comes back still stale leaves it, and the second detection must stop rather than
  // spin the tab (and, in production, every tab at once).
  window.sessionStorage.setItem('printstream:stale-reload-target', 'build-new')
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0)
})

test('a stale record for a different build does not block a fresh update', async () => {
  window.sessionStorage.setItem('printstream:stale-reload-target', 'build-abandoned')
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 1)
})

test('records the build it is reloading toward, so the next load can tell if it landed', async () => {
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(window.sessionStorage.getItem('printstream:stale-reload-target'), 'build-new')
})

test('a rollback to the running build cancels the pending update', async () => {
  busy.setAppBusy('mutations', true)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()
  assert.equal(reloads, 0)

  // The deploy went away and the server is back on what this tab already runs.
  staleness.observeServedWebBuildId('build-old')
  assert.equal(staleness.isWebUpdatePending(), false)
  busy.setAppBusy('mutations', false)
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(reloads, 0, 'nothing to move to')
})

test('refuses to auto-reload when the loop guard cannot be recorded', async () => {
  // Safari's "Block all cookies" makes sessionStorage throw. Reading returns null, which
  // never equals a build id, so a guard that only checks the READ silently degrades to
  // "always reload, unguarded" - the exact fleet-wide spin it exists to prevent, in the
  // one configuration where it cannot recover on the next load either.
  const storage = window.sessionStorage
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() { throw new DOMException('denied', 'SecurityError') }
  })
  try {
    staleness.observeServedWebBuildId('build-new')
    await settleProbe()
    assert.equal(reloads, 0, 'an unrecordable reload must not happen automatically')

    let notices: readonly { message: string }[] = []
    toastModule.toast.subscribe((entries) => { notices = entries })()
    assert.equal(notices.length, 1, 'it should fall back to asking')
  } finally {
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: storage })
  }
})

test('dismissing the manual notice does not permanently silence it', async () => {
  // The manual-only branch arms no idle watcher, so the toast is the only remaining
  // signal. If its id outlived the toast, `showUpdateNotice` would early-return forever
  // and the user would be stranded on a stale build with nothing on screen.
  window.sessionStorage.setItem('printstream:stale-reload-target', 'build-new')
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()

  let notices: readonly { id: number }[] = []
  toastModule.toast.subscribe((entries) => { notices = entries })()
  assert.equal(notices.length, 1)

  toastModule.toast.dismiss(notices[0]!.id)
  staleness.resetAppStalenessForTests()
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()

  let reshown: readonly unknown[] = []
  toastModule.toast.subscribe((entries) => { reshown = entries })()
  assert.equal(reshown.length, 1, 'the notice must be able to come back')
})

test('the deferred notice carries no reload button', async () => {
  // It promises to wait for the work in flight. The toast stack renders above the modal
  // layer and at the top of a phone screen, so a button next to that sentence is one
  // mis-tap away from discarding the unsaved project it just promised to protect.
  busy.setAppBusy('editor-edits', true)
  staleness.observeServedWebBuildId('build-new')
  await settleProbe()

  let notices: readonly { action?: unknown }[] = []
  toastModule.toast.subscribe((entries) => { notices = entries })()
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.action, undefined)
})

test('worker activation does not refresh an already-current page, including repeated activations', async () => {
  probedBuildId = 'build-old'
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  assert.equal(reloads, 0)
  assert.equal(staleness.isWebUpdatePending(), false)
})

test('worker activation cannot refresh without a known served build', async () => {
  probedBuildId = null
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  assert.equal(reloads, 0)
})

test('worker activation refreshes a confirmed stale page only once', async () => {
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  assert.equal(reloads, 1)
  assert.equal(window.sessionStorage.getItem('printstream:stale-reload-target'), 'build-new')
})

test('worker activation protects work and reloads after it finishes', async () => {
  busy.setAppBusy('slicing', true)
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  assert.equal(reloads, 0)
  assert.equal(staleness.isWebUpdatePending(), true)
  busy.setAppBusy('slicing', false)
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(reloads, 1)
})

test('a current page with an open dialog does not queue a later worker refresh', async () => {
  probedBuildId = 'build-old'
  busy.setAppBusy('dialog-open', true)
  await staleness.checkForServedWebUpdate()
  await settleProbe()
  assert.equal(staleness.isWebUpdatePending(), false)
  busy.setAppBusy('dialog-open', false)
  await new Promise((resolve) => setTimeout(resolve, 1_800))
  assert.equal(reloads, 0)
})
