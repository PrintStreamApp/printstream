import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import path from 'node:path'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { readSourceTree } from '../test-utils/sourceTree'

let dom: JSDOM
let createElement: typeof import('react').createElement
let render: typeof import('@testing-library/react').render
let cleanup: typeof import('@testing-library/react').cleanup
let BackAwareModal: typeof import('./BackAwareModal').BackAwareModal
let isBackGestureClose: typeof import('./BackAwareModal').isBackGestureClose
let appBusy: typeof import('../lib/appBusy')

before(async () => {
  // jsdom before Joy: its popup machinery does SSR detection at import time, and a
  // hoisted static import would leave the modal silently never mounting.
  dom = installJsdomGlobals()
  createElement = (await import('react')).createElement
  const testingLibrary = await import('@testing-library/react')
  render = testingLibrary.render
  cleanup = testingLibrary.cleanup
  const backAwareModal = await import('./BackAwareModal')
  BackAwareModal = backAwareModal.BackAwareModal
  isBackGestureClose = backAwareModal.isBackGestureClose
  appBusy = await import('../lib/appBusy')
})

after(() => {
  dom.window.close()
})

/**
 * Wait out jsdom's history traversal, which is genuinely asynchronous: `SessionHistory` queues the
 * traversal and then its `popstate` through `setTimeout`, so a `history.back()` lands a task or two
 * later. Awaiting a promise settles none of that, which is why this is a real timer.
 *
 * A close REQUEST needs no wait -- `handleClose` hands the reason straight to the consumer,
 * synchronously -- so the only other place this is used is where a reason is asserted ABSENT (the
 * scrim). There the wait IS the check: a wrapper that routed the click through `history.back()`, as
 * this one once did for every reason, would report the close a task later, and an assertion made
 * immediately would read that as a pass.
 */
function waitForHistoryTraversal() {
  return new Promise((resolve) => setTimeout(resolve, 50))
}

/**
 * The behaviour the structural guard below exists to protect: an open dialog is work in
 * progress, so it holds off an automatic reload onto a new build.
 */
test('an open dialog marks the app busy until it closes', () => {
  appBusy.resetAppBusyForTests()
  assert.equal(appBusy.isAppBusy(), false)

  // Children go in the props object: Joy's `Modal` types `children` as required, which
  // the third-argument form of `createElement` does not satisfy.
  render(createElement(BackAwareModal, {
    open: true,
    children: createElement('div', null, 'dialog body')
  }))
  assert.equal(appBusy.isAppBusy(), true, 'an open dialog must block an auto-reload')

  cleanup()
  assert.equal(appBusy.isAppBusy(), false, 'closing it must release the hold')
})

/**
 * WHY a dialog can trust `reason`: the history hop must not launder it.
 *
 * Closing the top dialog is routed through `history.back()` so the Back button and the dialog's own
 * dismissal agree on one stack. That hop used to drop the reason on the floor and re-enter with a
 * flat `backdropClick`, so every history-routed close looked identical: Escape, a scrim click and a
 * Back gesture were indistinguishable. The 3MF editor needs to tell them apart, because Escape backs
 * out of the active tool while Back closes the editor outright. It shipped a `reason ===
 * 'escapeKeyDown'` branch that could never once be taken, and nothing failed.
 */
test('the close reason survives the history hop', async () => {
  const reasons: string[] = []
  render(createElement(BackAwareModal, {
    open: true,
    onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
    children: createElement('div', null, 'dialog body')
  }))

  // The Modal ROOT carries the keydown handler, and the event has to originate inside it; a
  // `[role="dialog"]` lookup finds nothing here, because that role comes from `ModalDialog`.
  const modalRoot = dom.window.document.querySelector('.MuiModal-root')
  assert.ok(modalRoot, 'the modal must mount for this to mean anything')
  // No wait: a close REQUEST no longer hops through history, so the reason arrives on this task.
  modalRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  cleanup()
  assert.deepEqual(reasons, ['escapeKeyDown'], 'Escape must not arrive disguised as a backdrop click')
})

/**
 * A DECLINED Escape must cost the dialog nothing.
 *
 * The editor treats Escape as a non-closing gesture most of the time: it backs out of the active
 * tool, or clears the selection, and stays open. The wrapper used to route every reason through
 * `history.back()` before the consumer had any say, so a declined Escape popped the dialog's own
 * history entry while the dialog stayed on screen. The dialog was then open with nothing behind it:
 * browser Back navigated the route away instead of closing it, and closing any dialog opened on top
 * of it popped to a stack that prefixed the editor's, firing the editor's `onClose` a second time
 * and tearing it down (or raising "Discard unsaved changes?") over a gesture nobody made.
 *
 * The entry is now spent when the dialog actually CLOSES, which is the only moment that knows.
 */
test('an Escape the dialog declines leaves its history entry alone', async () => {
  const reasons: string[] = []
  render(createElement(BackAwareModal, {
    open: true,
    // Declines: records the reason and stays open, exactly as the editor does while a tool is live.
    onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
    children: createElement('div', null, 'dialog body')
  }))

  const modalRoot = dom.window.document.querySelector('.MuiModal-root')
  assert.ok(modalRoot, 'the modal must mount for this to mean anything')
  modalRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  assert.deepEqual(reasons, ['escapeKeyDown'], 'the reason must still arrive')

  // The entry must still be there, which is observable as Back still closing THIS dialog. With the
  // entry already spent, Back belongs to whatever is underneath and the route navigates away.
  dom.window.history.back()
  await waitForHistoryTraversal()

  cleanup()
  // `closeClick`, not `backdropClick`: Back is a deliberate dismissal and has to survive the
  // scrim-click filter in `handleClose`, which reporting it as a backdrop click would have hidden it
  // behind. Nothing tells Back from the X, on purpose.
  assert.deepEqual(reasons, ['escapeKeyDown', 'closeClick'],
    'Back did not reach the dialog: its history entry was spent by the declined Escape')
})

/**
 * A DECLINED close must not be re-fired by the next dialog opened over it.
 *
 * This is the reported "asked twice to stay or discard". The wrapper used to pop the dialog's own
 * history entry the moment a close was REQUESTED, before the consumer had answered. Decline it --
 * the 3MF editor's "Keep editing" -- and the dialog was left open with no entry of its own, so the
 * next dialog opened inside it pushed `[editor, inner]` over an entry that said `[]`. Closing that
 * inner dialog popped to a stack prefixing the editor's, which reads as "close everything above
 * it", and the editor was asked to close again over a gesture nobody made.
 *
 * Escape was exempted from the hop first, which fixed backing out of a TOOL and left this: the X
 * and the scrim still spent the entry before the discard prompt had been answered.
 */
test('a dialog opened over a declined close does not re-fire it', async () => {
  const reasons: string[] = []
  const { ModalClose } = await import('@mui/joy')
  render(createElement(BackAwareModal, {
    open: true,
    // Declines: records the reason and stays open, exactly as the editor does while its
    // "Discard unsaved changes?" prompt is unanswered (and after "Keep editing").
    onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
    children: createElement('div', null, createElement(ModalClose, null))
  }))

  const closeButton = dom.window.document.querySelector('.MuiModalClose-root')
  assert.ok(closeButton, 'the close button must mount for this to mean anything')
  closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(reasons, ['closeClick'], 'the X must ask once')

  // Anything the user opens inside it next and closes again: settings, save-as, a material picker.
  // The push happens in an effect, which `render` flushes, so nothing is pending before the close.
  const inner = render(createElement(BackAwareModal, {
    open: true,
    onClose: () => {},
    children: createElement('div', null, 'inner dialog')
  }))
  inner.rerender(createElement(BackAwareModal, {
    open: false,
    onClose: () => {},
    children: createElement('div', null, 'inner dialog')
  }))
  // The inner dialog's close DOES spend its history entry, so give that traversal time to land on
  // the outer dialog, which is the whole failure this test exists for.
  await waitForHistoryTraversal()

  cleanup()
  assert.deepEqual(reasons, ['closeClick'], 'closing the inner dialog must not re-ask the outer one')
})

/**
 * The close button closes the dialog BY ITSELF, with no `onClick` of its own.
 *
 * Joy's `ModalClose` reads the modal's `onClose` off `CloseModalContext` and calls it with
 * `'closeClick'`, then calls any `onClick` the consumer passed. So a consumer that wires its own
 * close handler onto the button runs the whole close path twice per click. This pins the half that
 * makes passing one unnecessary: without an `onClick`, one click still produces exactly one close.
 */
test('the close button closes the dialog on its own, exactly once', async () => {
  const reasons: string[] = []
  const { ModalClose } = await import('@mui/joy')
  render(createElement(BackAwareModal, {
    open: true,
    onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
    children: createElement('div', null, createElement(ModalClose, null))
  }))

  const closeButton = dom.window.document.querySelector('.MuiModalClose-root')
  assert.ok(closeButton, 'the close button must mount for this to mean anything')
  // No wait: the duplicate this pins is Joy calling `onClose` and then the consumer's `onClick`,
  // both on the click's own task, so a second close would already be recorded.
  closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))

  cleanup()
  assert.deepEqual(reasons, ['closeClick'], 'one click on the X must be one close')
})

/**
 * TWO elements can be the scrim, and the one most dialogs actually hit is the second.
 *
 * A plain dialog's click lands on Joy's backdrop SLOT (`useModal`'s `createHandleBackdropClick`).
 * But a `ScrollableModalDialog` -- print prep, the slice dialogs, every picker -- wraps its dialog
 * in `ModalOverflow`, which is `position: absolute; inset: 0` and therefore COVERS the backdrop
 * entirely; its own `onClick` reports `backdropClick` through `CloseModalContext` instead
 * (`@mui/joy/ModalOverflow/ModalOverflow.js`). Both land on the wrapper's `onClose`, so one filter
 * covers both, but a test that exercises only the backdrop slot pins the minority path: a change
 * that filtered at `slotProps.backdrop` would leave every large dialog closing on a scrim click
 * with the suite still green.
 *
 * Either handler returns early unless `event.target === event.currentTarget`, so the event has to
 * originate ON the element -- a click dispatched at the dialog and left to bubble is correctly
 * ignored, and would make these tests pass against a wrapper that does close on the scrim. Hence
 * the lookup is asserted rather than assumed.
 */
const SCRIM_SELECTORS = {
  'the backdrop slot': '.MuiModal-backdrop',
  'the ModalOverflow scroller': '.MuiModalOverflow-root'
} as const

function clickTheScrim(selector: string) {
  const scrim = dom.window.document.querySelector(selector)
  assert.ok(scrim, `the scrim (${selector}) must be in the DOM for this to mean anything`)
  scrim.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
}

/**
 * Render the children a given scrim needs: `ModalOverflow` only exists if a dialog mounts one.
 * Mirrors what `ScrollableModalDialog` (`components/ScrollableDialog.tsx`) puts in the tree.
 */
async function dialogBodyFor(selector: string) {
  if (selector !== SCRIM_SELECTORS['the ModalOverflow scroller']) {
    return createElement('div', null, 'dialog body')
  }
  const { ModalDialog, ModalOverflow } = await import('@mui/joy')
  return createElement(ModalOverflow, null, createElement(ModalDialog, null, 'dialog body'))
}

/**
 * A click on the scrim is NOT a dismissal.
 *
 * Joy's default is to close on it, and the cost lands unevenly: the dialogs it is easiest to
 * overshoot are the wide ones (print prep, the AMS slot editor, the 3MF editor) that hold the most
 * unfinished work, and a scrim click is exactly what a misjudged click at a dialog's edge produces.
 * So the wrapper drops the reason instead of each dialog remembering to check it -- MUI removed
 * `disableBackdropClick` in v5 and documents this check as the replacement.
 */
for (const [scrimName, selector] of Object.entries(SCRIM_SELECTORS)) {
  test(`a click on ${scrimName} does not close a dialog`, async () => {
    const reasons: string[] = []
    render(createElement(BackAwareModal, {
      open: true,
      onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
      children: await dialogBodyFor(selector)
    }))

    clickTheScrim(selector)
    // Kept: the assertion is an ABSENCE, so a close that merely arrived late would pass without it.
    await waitForHistoryTraversal()

    cleanup()
    assert.deepEqual(reasons, [], `${scrimName} must not ask the dialog to close`)
  })

  /** The documented opt-out, for a surface with nothing to lose (see `dismissOnBackdropClick`). */
  test(`dismissOnBackdropClick lets ${scrimName} close a dialog again`, async () => {
    const reasons: string[] = []
    render(createElement(BackAwareModal, {
      open: true,
      dismissOnBackdropClick: true,
      onClose: (_event: unknown, reason: string) => { reasons.push(reason) },
      children: await dialogBodyFor(selector)
    }))

    clickTheScrim(selector)

    cleanup()
    assert.deepEqual(reasons, ['backdropClick'], 'an opted-in dialog must still hear the scrim')
  })
}

/**
 * Back is reported as `closeClick` like the X, but stays TELLABLE from it.
 *
 * `useEditorSave` logs the pair of sources behind a duplicate close request so an intermittent one
 * can be traced, and Back and the X are the two candidates a reader most needs to separate. The
 * reason cannot carry that (Joy has three members, and both gestures ask for the same thing), so
 * the marker rides the synthetic event instead.
 */
test('Back is distinguishable from the close button without changing the reason', async () => {
  const seen: { reason: string; fromBack: boolean }[] = []
  const { ModalClose } = await import('@mui/joy')
  render(createElement(BackAwareModal, {
    open: true,
    onClose: (event: unknown, reason: string) => { seen.push({ reason, fromBack: isBackGestureClose(event) }) },
    children: createElement('div', null, createElement(ModalClose, null))
  }))

  const closeButton = dom.window.document.querySelector('.MuiModalClose-root')
  assert.ok(closeButton, 'the close button must mount for this to mean anything')
  closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))

  // Declined above (the handler only records), so the dialog's history entry is still there for
  // Back to spend -- which is what makes the second gesture reach this same handler.
  dom.window.history.back()
  await waitForHistoryTraversal()

  cleanup()
  assert.deepEqual(seen, [
    { reason: 'closeClick', fromBack: false },
    { reason: 'closeClick', fromBack: true }
  ], 'both must report closeClick, and only Back must carry the marker')
})

/** The wrapper itself: the one module that may mount Joy's `Modal`. */
const OWNER = path.join('components', 'BackAwareModal.tsx')

/**
 * The transient shell shown while a code-split dialog's chunk loads.
 *
 * Exempt on purpose. It is replaced by the real dialog (which registers) within a chunk
 * fetch, and routing it through `BackAwareModal` would push and immediately pop a history
 * entry for something the user never interacted with.
 */
const LAZY_FALLBACK = path.join('components', 'LazyDialogFallback.tsx')

/**
 * A REGRESSION guard: dialogs mount `BackAwareModal`, never Joy's `Modal` directly.
 *
 * `BackAwareModal` is the single place every dialog announces itself, and two behaviours
 * hang off that stack. Browser Back closes the top dialog instead of navigating away, and
 * an open dialog marks the app busy so an automatic update cannot reload the page out
 * from under a half-filled form (`lib/appBusy.ts`, `lib/appStaleness.ts`).
 *
 * A dialog that reaches for Joy's `Modal` gets neither, and nothing about it looks wrong:
 * it renders identically, and the loss only shows up as Back leaving the page, or as
 * someone's half-typed dialog vanishing on a deploy. Both calibration dialogs had already
 * drifted this way. Hence a build failure rather than a convention note.
 */
test('dialogs mount BackAwareModal, never Joy Modal directly', async () => {
  const offenders: string[] = []

  for (const { relativePath: relative, source } of await readSourceTree()) {
    if (relative === OWNER || relative === LAZY_FALLBACK) continue
    if (relative.includes('.test.') || relative.includes('.testkit.')) continue

    // Match the whole import STATEMENT, not a line. Joy imports are routinely formatted
    // across a dozen lines, and a line-scanning version of this test reported a clean
    // build while `FormDialog` - the shared dialog primitive every form is told to reuse -
    // sat on a raw Joy `Modal` the whole time, along with three other dialogs.
    for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@mui\/joy['"]/g)) {
      const specifiers = match[1]!.split(',').map((entry) => entry.trim().split(/\s+as\s+/)[0]!.trim())
      // `ModalClose`, `ModalDialog`, and `ModalOverflow` are fine; only bare `Modal` is not.
      if (!specifiers.includes('Modal')) continue
      offenders.push(`${relative}:${source.slice(0, match.index).split('\n').length}`)
    }

    // Subpath and namespace forms reach the same component by another door.
    if (/from\s*['"]@mui\/joy\/Modal['"]/.test(source)) offenders.push(`${relative} (@mui/joy/Modal subpath import)`)
  }

  assert.deepEqual(
    offenders,
    [],
    `Use <BackAwareModal> from components/BackAwareModal instead of Joy's Modal:\n  ${offenders.join('\n  ')}`
  )
})

/**
 * The dialogs allowed to close on a click outside them: image viewers, nothing else.
 *
 * Listed rather than inferred because the reason is per-surface and not visible in the code -- an
 * image viewer holds no work a stray click can destroy, and its dark surround genuinely reads as
 * "the thing I am looking past".
 *
 * The value is HOW MANY opted-in dialogs that file may hold, not a boolean, because a file is not a
 * dialog: `PrinterJobMediaStrip` holds an image lightbox and a live camera viewer with controls, so
 * approving the file would have waved the camera one through unreviewed. (It is absent below because
 * its lightbox is now the shared `ImageLightbox`, which is the better version of the same fix.)
 * `MarketingHomePage` is a private module and absent from the public build, so a listed file that
 * does not exist is fine; a use that is not listed is not.
 */
const BACKDROP_DISMISSIBLE = new Map([
  [path.join('components', 'ImageLightbox.tsx'), 1],
  [path.join('private', 'cloud', 'MarketingHomePage.tsx'), 1]
])

/**
 * Blank out comments, so PROSE about the prop does not read as a use of it.
 *
 * Every opt-in carries a comment naming `dismissOnBackdropClick` and saying why, and so does any
 * dialog explaining that it deliberately does NOT set it. Scanning raw source finds the word in
 * both, and would fail the build telling whoever wrote the second comment to declare their print
 * dialog an image viewer. Line comments are stripped only where `//` does not follow a `:`, so a
 * `https://` inside a string cannot swallow the rest of its line.
 */
function withoutComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * A REGRESSION guard: only an image viewer opts back into closing on a scrim click.
 *
 * The opt-in is one word on a JSX element, it silences the app-wide rule for that dialog, and
 * nothing about the result looks wrong -- it just behaves the way Joy did before, which is the
 * behaviour someone reaching for the prop is usually trying to restore. The dialogs where that is
 * most tempting (a picker, a settings catalog, anything with a Cancel) are exactly the ones the rule
 * exists for, so the list is reviewed here rather than left to whoever is mid-task.
 */
test('only image viewers opt back into closing on a scrim click', async () => {
  const unapproved: string[] = []

  for (const file of await readSourceTree()) {
    const relative = file.relativePath
    if (relative === OWNER || relative.includes('.test.') || relative.includes('.testkit.')) continue

    const source = withoutComments(file.source)
    const uses = source.match(/\bdismissOnBackdropClick\b/g)?.length ?? 0
    if (uses === 0) continue

    const allowed = BACKDROP_DISMISSIBLE.get(relative) ?? 0
    if (uses > allowed) unapproved.push(`${relative} (${uses} opted in, ${allowed} approved)`)
  }

  assert.deepEqual(
    unapproved,
    [],
    'A dialog closes only on a deliberate gesture (X, footer button, Escape, Back). If these really '
      + `are image viewers, raise their count in BACKDROP_DISMISSIBLE:\n  ${unapproved.join('\n  ')}`
  )
})

/**
 * A REGRESSION guard: `ModalClose` never carries an `onClick`.
 *
 * The button is already wired to the dialog it sits in -- Joy reads the modal's `onClose` off
 * `CloseModalContext` and calls it with `'closeClick'` BEFORE handing the event to any `onClick`
 * the consumer passed. So `<ModalClose onClick={close} />` runs the close path twice per click,
 * and it reads as the obvious way to wire the button up, which is why two surfaces did it.
 *
 * On an unconditional close the second run is an invisible no-op, which is exactly why this has to
 * fail the build rather than be noticed: on a CONDITIONAL close it is not. Measured on the 3MF
 * editor, one click on an X wired this way raised "Discard unsaved changes?" TWICE -- the second
 * queued behind the first by `PromptDialogProvider`, so it arrived the moment the user answered,
 * over a gesture they made once.
 */
test('ModalClose never carries its own onClick', async () => {
  const offenders: string[] = []

  for (const { relativePath: relative, source } of await readSourceTree()) {
    if (relative.includes('.test.') || relative.includes('.testkit.')) continue

    // The element's whole prop list, which routinely wraps across lines.
    for (const match of source.matchAll(/<ModalClose\b[^>]*\/?>/g)) {
      if (!/\bonClick\s*=/.test(match[0]!)) continue
      offenders.push(`${relative}:${source.slice(0, match.index).split('\n').length}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `<ModalClose> already calls the modal's onClose; drop the onClick or the dialog closes twice:\n  ${offenders.join('\n  ')}`
  )
})
