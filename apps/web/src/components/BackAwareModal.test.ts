import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JSDOM } from 'jsdom'
import { installJsdomGlobals } from '../test-utils/jsdom'

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let dom: JSDOM
let createElement: typeof import('react').createElement
let render: typeof import('@testing-library/react').render
let cleanup: typeof import('@testing-library/react').cleanup
let BackAwareModal: typeof import('./BackAwareModal').BackAwareModal
let appBusy: typeof import('../lib/appBusy')

before(async () => {
  // jsdom before Joy: its popup machinery does SSR detection at import time, and a
  // hoisted static import would leave the modal silently never mounting.
  dom = installJsdomGlobals()
  createElement = (await import('react')).createElement
  const testingLibrary = await import('@testing-library/react')
  render = testingLibrary.render
  cleanup = testingLibrary.cleanup
  BackAwareModal = (await import('./BackAwareModal')).BackAwareModal
  appBusy = await import('../lib/appBusy')
})

after(() => {
  dom.window.close()
})

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
  modalRoot.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  // The hop is a real `history.back()`, so `onClose` lands on a later task via `popstate`.
  await new Promise((resolve) => setTimeout(resolve, 50))

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
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.deepEqual(reasons, ['escapeKeyDown'], 'the reason must still arrive')

  // The entry must still be there, which is observable as Back still closing THIS dialog. With the
  // entry already spent, Back belongs to whatever is underneath and the route navigates away.
  dom.window.history.back()
  await new Promise((resolve) => setTimeout(resolve, 50))

  cleanup()
  assert.deepEqual(reasons, ['escapeKeyDown', 'backdropClick'],
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
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(reasons, ['closeClick'], 'the X must ask once')

  // Anything the user opens inside it next and closes again: settings, save-as, a material picker.
  const inner = render(createElement(BackAwareModal, {
    open: true,
    onClose: () => {},
    children: createElement('div', null, 'inner dialog')
  }))
  await new Promise((resolve) => setTimeout(resolve, 50))
  inner.rerender(createElement(BackAwareModal, {
    open: false,
    onClose: () => {},
    children: createElement('div', null, 'inner dialog')
  }))
  await new Promise((resolve) => setTimeout(resolve, 50))

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
  closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  // The close is routed through a real `history.back()`, so `onClose` lands on a later task.
  await new Promise((resolve) => setTimeout(resolve, 50))

  cleanup()
  assert.deepEqual(reasons, ['closeClick'], 'one click on the X must be one close')
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

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) yield full
  }
}

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

  for await (const file of walk(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file)
    if (relative === OWNER || relative === LAZY_FALLBACK) continue
    if (relative.includes('.test.') || relative.includes('.testkit.')) continue

    const source = await readFile(file, 'utf8')

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

  for await (const file of walk(SRC_ROOT)) {
    const relative = path.relative(SRC_ROOT, file)
    if (relative.includes('.test.') || relative.includes('.testkit.')) continue

    const source = await readFile(file, 'utf8')
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
