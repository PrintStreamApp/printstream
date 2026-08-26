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
