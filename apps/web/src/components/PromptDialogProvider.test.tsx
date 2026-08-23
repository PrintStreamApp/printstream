/**
 * `submitValue`: the server decides, and its answer arrives where the user is
 * typing.
 *
 * The alternative this replaced was shipping the rule to the browser, a rename
 * that must not collide checked a list of existing names fetched into the page,
 * which is a partial copy of a database constraint and goes stale the moment
 * anyone else takes the name.
 */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

// Joy's Modal does SSR detection at import time, so load it after the globals exist.
const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { PromptDialogProvider, usePromptDialog } = await import('./PromptDialogProvider')
const { Button } = await import('@mui/joy')

afterEach(() => { cleanup() })
after(() => { dom.window.close() })

function renderPrompt(options: Record<string, unknown>, onResolved: (value: string | null) => void) {
  function Opener() {
    const { promptText } = usePromptDialog()
    return (
      <Button onClick={() => { void promptText({ label: 'Name', ...options }).then(onResolved) }}>
        Open
      </Button>
    )
  }
  render(
    <CssVarsProvider>
      <PromptDialogProvider>
        <Opener />
      </PromptDialogProvider>
    </CssVarsProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
}

function typeName(value: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } })
}

test('a rejected submit keeps the dialog open, the message visible, and the typing intact', async () => {
  const attempts: string[] = []
  let resolved: string | null | undefined
  renderPrompt(
    {
      initialValue: 'The Shop',
      submitValue: async (value: string) => {
        attempts.push(value)
        return 'A workspace with that name already exists. Pick another.'
      }
    },
    (value) => { resolved = value }
  )

  typeName('My Workspace')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => {
    assert.ok(screen.queryByText(/already exists/))
  })
  // The point of showing it here rather than on the surface behind: the value is
  // still there to correct, and the promise has not resolved.
  assert.equal((screen.getByRole('textbox') as HTMLInputElement).value, 'My Workspace')
  assert.equal(resolved, undefined)
  assert.deepEqual(attempts, ['My Workspace'])

  // Editing clears the server's answer, it was about the value that WAS in the
  // field, and leaving it up would reject the new name before anything asked.
  typeName('My Workspace 2')
  await waitFor(() => {
    assert.equal(screen.queryByText(/already exists/), null)
  })
})

test('an accepted submit closes the dialog and resolves with the value', async () => {
  let resolved: string | null | undefined
  renderPrompt(
    { initialValue: 'The Shop', submitValue: async () => null },
    (value) => { resolved = value }
  )

  typeName('Front Office')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => { assert.equal(resolved, 'Front Office') })
  assert.equal(screen.queryByRole('textbox'), null)
})

test('validation still runs first, so a value the browser can reject never reaches the server', async () => {
  const attempts: string[] = []
  renderPrompt(
    {
      initialValue: 'The Shop',
      validateValue: (value: string) => (value.trim() ? null : 'Give the workspace a name.'),
      submitValue: async (value: string) => { attempts.push(value); return null }
    },
    () => {}
  )

  typeName('   ')
  await waitFor(() => { assert.ok(screen.queryByText('Give the workspace a name.')) })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => { assert.deepEqual(attempts, []) })
  assert.ok(screen.queryByRole('textbox'), 'the dialog stays open')
})

test('without submitValue the dialog closes on save, as every existing caller expects', async () => {
  let resolved: string | null | undefined
  renderPrompt({ initialValue: 'The Shop' }, (value) => { resolved = value })

  typeName('Front Office')
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => { assert.equal(resolved, 'Front Office') })
})
