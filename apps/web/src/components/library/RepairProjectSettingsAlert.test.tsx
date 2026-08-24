import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import type { ThreeMfSettingsRepairReason } from '@printstream/shared'

const dom = installJsdomGlobals()

// Joy does SSR detection at import time, so load @mui/joy and the component under test only after
// the jsdom globals exist (see apps/web/the development notes).
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { RepairProjectSettingsAlert } = await import('./RepairProjectSettingsAlert')

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderAlert(props: {
  reasons: ThreeMfSettingsRepairReason[]
  unrepairableReasons?: ThreeMfSettingsRepairReason[]
  onRepairInEditor?: () => void
  repairInEditorError?: string | null
}) {
  // gcTime Infinity: imported after jsdom, react-query would otherwise schedule a ref'd 5-minute
  // timer at cleanup and hang the runner (see apps/web/the development notes).
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        CssVarsProvider,
        null,
        React.createElement(RepairProjectSettingsAlert, props)
      )
    )
  )
}

/**
 * The defect repaired IN THE EDITOR must offer a button. Save itself greys out on a project with no
 * unsaved edits, so before this the notice named a remedy ("saving writes them back") beside a
 * control the user could not press: unreachable on exactly the projects that needed it, which is
 * every freshly-opened one.
 */
test('filamentPhysics offers a Repair action when the host can repair', () => {
  let saved = 0
  renderAlert({ reasons: ['filamentPhysics'], onRepairInEditor: () => { saved += 1 } })

  const button = screen.getByRole('button', { name: /repair/i })
  fireEvent.click(button)
  assert.equal(saved, 1)
})

/** A host with no repair path must not grow a button that would do nothing. */
test('filamentPhysics renders advisory-only when the host cannot repair', () => {
  renderAlert({ reasons: ['filamentPhysics'] })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  assert.ok(screen.getByText(/Open it in the editor and save to restore them/i))
})

/**
 * The public editor opens a file off the user's disk: there is no library row to POST to, so the
 * route's button must not render. The notice still does: knowing the file is broken is useful even
 * where this surface cannot fix it.
 */
test('a project with no stored file still warns, without the route button', () => {
  renderAlert({ reasons: ['flushMatrix'] })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  assert.ok(screen.getByText(/left over from a different printer/i))
  assert.ok(screen.getByText(/Open it in the editor and press Repair, then save/i))
})

/**
 * ONE repair model wherever an editor session exists: mixed defects stage EVERYTHING behind one
 * button (the byte repairs synchronously, the physics restore through the same click), even for a
 * stored library file. The route's instant-write button is reserved for surfaces with no session.
 */
test('mixed defects with an editor session stage everything behind one button', () => {
  let staged = 0
  renderAlert({ reasons: ['filamentPhysics', 'filamentIds'], onRepairInEditor: () => { staged += 1 } })

  fireEvent.click(screen.getByRole('button', { name: /repair/i }))
  assert.equal(staged, 1)
  assert.ok(screen.getByText(/need repairing/i))
  assert.ok(screen.getByText(/Repair, then save the project/i))
})

/**
 * There is NO instant repair anywhere: a surface with no editor session (the print-prep dialog)
 * renders the advisory pointing at the editor, and the dialog itself blocks printing the flagged
 * file. A button here would either write bytes behind the user's back or report "nothing to do".
 */
test('a surface without an editor session gets the advisory, never a button', () => {
  renderAlert({ reasons: ['filamentIds'] })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  assert.ok(screen.getByText(/Open it in the editor and press Repair, then save/i))
})

/**
 * An all-or-nothing repair that could not run must SAY so in place of the body. Silence reads as
 * "the button did nothing", and the user cannot tell that their project is still defective.
 */
test('a failed in-editor repair replaces the body with its reason', () => {
  renderAlert({
    reasons: ['filamentPhysics'],
    onRepairInEditor: () => {},
    repairInEditorError: 'We couldn\u2019t match material 3 to a known preset, so nothing was changed.'
  })

  assert.ok(screen.getByText(/couldn\u2019t match material 3/i))
  assert.equal(screen.queryByText(/Repairing restores them/i), null)
})

/**
 * A failure must be legible at a glance, not a swapped paragraph inside an identically-styled
 * warning: reported as "hard to tell that the message even changed".
 */
test('a failed in-editor repair is visually distinct, not just different text', () => {
  const { container } = renderAlert({
    reasons: ['filamentPhysics'],
    onRepairInEditor: () => {},
    repairInEditorError: 'Material 3 could not be matched.'
  })

  assert.ok(screen.getByText(/Couldn’t repair this project/i), 'the title must change')
  assert.ok(screen.getByRole('button', { name: /try again/i }), 'the action must re-label')
  assert.ok(container.querySelector('.MuiAlert-colorDanger'), 'the alert must switch to danger')
})

// Issue #101. Every inspector computes whether a defect can actually be repaired, and that signal
// used to be discarded before it reached the wire, so an unfixable defect arrived as a Repair
// button that wrote a new library version, changed nothing, and left the banner up on reopen.
test('withholds Repair when every flagged defect declines, and names the manual remedy', () => {
  const onRepairInEditor = () => assert.fail('the button must not be offered at all')
  renderAlert({ reasons: ['inheritsGroup'], unrepairableReasons: ['inheritsGroup'], onRepairInEditor })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  // Point somewhere real instead: the value cannot be derived from the file with certainty, which
  // is exactly when a person holding the original project has to make the call.
  assert.match(document.body.textContent ?? '', /can’t be repaired automatically/i)
  assert.match(document.body.textContent ?? '', /Bambu Studio/i)
})

// Per REASON, not per file: collapsing to one flag would strand the fixable defect behind the
// unfixable one.
test('keeps Repair when only SOME defects decline, and says what it will not fix', () => {
  let clicked = 0
  renderAlert({
    reasons: ['flushMatrix', 'inheritsGroup'],
    unrepairableReasons: ['inheritsGroup'],
    onRepairInEditor: () => { clicked += 1 }
  })

  const button = screen.getByRole('button', { name: /repair/i })
  fireEvent.click(button)
  assert.equal(clicked, 1)
  assert.match(document.body.textContent ?? '', /can’t be repaired automatically and needs Bambu Studio/i)
})

// Absent means UNKNOWN, not "none": an older bridge, or an index cached before parser v30, sends
// nothing, and the honest fallback is the behaviour that shipped before this field existed.
test('offers Repair as before when repairability is unknown', () => {
  renderAlert({ reasons: ['inheritsGroup'], onRepairInEditor: () => {} })

  assert.ok(screen.getByRole('button', { name: /repair/i }))
  assert.doesNotMatch(document.body.textContent ?? '', /can’t be repaired automatically/i)
})
