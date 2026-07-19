import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SettingsTuneButton } = await import('./SettingsTuneButton')

afterEach(() => cleanup())
after(() => dom.window.close())

test('shows the changed count in the badge, hides it at zero, and fires onClick', () => {
  let clicks = 0
  const { rerender } = render(
    <CssVarsProvider>
      <SettingsTuneButton changedCount={3} title="Per-object settings" ariaLabel="Per-object settings for Cube" onClick={() => { clicks += 1 }} />
    </CssVarsProvider>
  )
  // The count is visible when there are overrides — the whole point of the convention.
  assert.ok(screen.getByText('3'))
  const button = screen.getByRole('button', { name: 'Per-object settings for Cube' })
  fireEvent.click(button)
  assert.equal(clicks, 1)

  // Zero changes → no count rendered (unchanged rows show a plain icon).
  rerender(
    <CssVarsProvider>
      <SettingsTuneButton changedCount={0} title="Per-object settings" ariaLabel="Per-object settings for Cube" onClick={() => {}} />
    </CssVarsProvider>
  )
  assert.equal(screen.queryByText('3'), null)
  assert.equal(screen.queryByText('0'), null)
})

test('disabled button does not fire onClick', () => {
  let clicks = 0
  render(
    <CssVarsProvider>
      <SettingsTuneButton changedCount={0} title="Choose a quality profile first" ariaLabel="Per-object settings for Cone" disabled onClick={() => { clicks += 1 }} />
    </CssVarsProvider>
  )
  const button = screen.getByRole('button', { name: 'Per-object settings for Cone' }) as HTMLButtonElement
  assert.equal(button.disabled, true)
  fireEvent.click(button)
  assert.equal(clicks, 0)
})
