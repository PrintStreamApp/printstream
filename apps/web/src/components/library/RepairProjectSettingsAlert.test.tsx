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
  fileId?: string
  reasons: ThreeMfSettingsRepairReason[]
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
 * control the user could not press — unreachable on exactly the projects that needed it, which is
 * every freshly-opened one.
 */
test('filamentPhysics offers a Repair action when the host can repair', () => {
  let saved = 0
  renderAlert({ fileId: 'file-1', reasons: ['filamentPhysics'], onRepairInEditor: () => { saved += 1 } })

  const button = screen.getByRole('button', { name: /repair/i })
  fireEvent.click(button)
  assert.equal(saved, 1)
})

/** A host with no repair path must not grow a button that would do nothing. */
test('filamentPhysics renders advisory-only when the host cannot repair', () => {
  renderAlert({ fileId: 'file-1', reasons: ['filamentPhysics'] })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  assert.ok(screen.getByText(/Saving this project writes them back/i))
})

/**
 * The public editor opens a file off the user's disk: there is no library row to POST to, so the
 * route's button must not render. The notice still does — knowing the file is broken is useful even
 * where this surface cannot fix it.
 */
test('a project with no stored file still warns, without the route button', () => {
  renderAlert({ reasons: ['flushMatrix'] })

  assert.equal(screen.queryByRole('button', { name: /repair/i }), null)
  assert.ok(screen.getByText(/don’t match its printer/i))
  assert.ok(screen.getByText(/Open it from your library to repair it/i))
})

/**
 * Mixed defects keep the ROUTE button: the in-editor repair only covers the physics half, so
 * dropping the button here would leave the other defect unrepairable.
 */
test('filamentPhysics mixed with a route-repairable defect keeps the route button', () => {
  renderAlert({ fileId: 'file-1', reasons: ['filamentPhysics', 'filamentIds'], onRepairInEditor: () => {} })

  assert.ok(screen.getByRole('button', { name: /repair/i }))
  assert.ok(screen.getByText(/need repairing/i))
})

/**
 * An all-or-nothing repair that could not run must SAY so in place of the body. Silence reads as
 * "the button did nothing", and the user cannot tell that their project is still defective.
 */
test('a failed in-editor repair replaces the body with its reason', () => {
  renderAlert({
    fileId: 'file-1',
    reasons: ['filamentPhysics'],
    onRepairInEditor: () => {},
    repairInEditorError: 'We couldn\u2019t match material 3 to a known preset, so nothing was changed.'
  })

  assert.ok(screen.getByText(/couldn\u2019t match material 3/i))
  assert.equal(screen.queryByText(/Repairing restores them/i), null)
})

/**
 * A failure must be legible at a glance, not a swapped paragraph inside an identically-styled
 * warning — reported as "hard to tell that the message even changed".
 */
test('a failed in-editor repair is visually distinct, not just different text', () => {
  const { container } = renderAlert({
    fileId: 'file-1',
    reasons: ['filamentPhysics'],
    onRepairInEditor: () => {},
    repairInEditorError: 'Material 3 could not be matched.'
  })

  assert.ok(screen.getByText(/Couldn’t repair this project/i), 'the title must change')
  assert.ok(screen.getByRole('button', { name: /try again/i }), 'the action must re-label')
  assert.ok(container.querySelector('.MuiAlert-colorDanger'), 'the alert must switch to danger')
})
