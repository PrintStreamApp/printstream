import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { default: MenuItem } = await import('@mui/joy/MenuItem')
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { SplitButton, splitButtonGroupAppearance } = await import('./SplitButton')

afterEach(() => cleanup())
after(() => dom.window.close())

function renderSplitButton(props: { disabled?: boolean, primaryDisabled?: boolean, onClick?: () => void, onMenuItem?: () => void }) {
  return render(
    <CssVarsProvider>
      <SplitButton
        ariaLabel="save"
        menuAriaLabel="More save options"
        label="Save"
        disabled={props.disabled}
        primaryDisabled={props.primaryDisabled}
        disabledReason="No unsaved changes"
        onClick={props.onClick ?? (() => {})}
      >
        <MenuItem onClick={props.onMenuItem ?? (() => {})}>Save as new…</MenuItem>
      </SplitButton>
    </CssVarsProvider>
  )
}

test('a disabled primary leaves the menu reachable', () => {
  let primaryClicks = 0
  let menuClicks = 0
  renderSplitButton({ primaryDisabled: true, onClick: () => { primaryClicks += 1 }, onMenuItem: () => { menuClicks += 1 } })

  const primary = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  assert.equal(primary.disabled, true)
  fireEvent.click(primary)
  assert.equal(primaryClicks, 0)

  // The whole point of the state: Save-as stays available while Save is greyed.
  const caret = screen.getByRole('button', { name: 'More save options' }) as HTMLButtonElement
  assert.equal(caret.disabled, false)
  fireEvent.click(caret)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Save as new…' }))
  assert.equal(menuClicks, 1)
})

test('a disabled group disables the primary even though it passes its own disabled prop', () => {
  // Joy's Button prefers its own `disabled` prop over the ButtonGroup's, so `primaryDisabled`
  // defaulting to false must not re-enable the primary half of a fully disabled group.
  renderSplitButton({ disabled: true })
  assert.equal((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled, true)
  assert.equal((screen.getByRole('button', { name: 'More save options' }) as HTMLButtonElement).disabled, true)
})

test('both halves stay live when nothing is disabled', () => {
  let primaryClicks = 0
  renderSplitButton({ onClick: () => { primaryClicks += 1 } })
  const primary = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
  assert.equal(primary.disabled, false)
  fireEvent.click(primary)
  assert.equal(primaryClicks, 1)
  assert.equal((screen.getByRole('button', { name: 'More save options' }) as HTMLButtonElement).disabled, false)
})

test('the group de-emphasises only while the primary half alone is disabled', () => {
  const emphasised = { variant: 'solid' as const, color: 'primary' as const }
  assert.deepEqual(splitButtonGroupAppearance({ ...emphasised, disabled: false, primaryDisabled: false }), emphasised)
  assert.deepEqual(
    splitButtonGroupAppearance({ ...emphasised, disabled: false, primaryDisabled: true }),
    { variant: 'soft', color: 'neutral' }
  )
  // A fully disabled group keeps its own look: Joy greys both halves, so there is no mismatch to
  // correct, and rewriting it would make the two disabled states look different.
  assert.deepEqual(splitButtonGroupAppearance({ ...emphasised, disabled: true, primaryDisabled: false }), emphasised)
  assert.deepEqual(splitButtonGroupAppearance({ ...emphasised, disabled: true, primaryDisabled: true }), emphasised)
})
