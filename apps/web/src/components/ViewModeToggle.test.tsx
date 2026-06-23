import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

afterEach(async () => {
  const { cleanup } = await import('@testing-library/react')
  cleanup()
})

after(() => {
  dom.window.close()
})

test('ViewModeToggle renders both segments and emits the clicked mode', async () => {
  const { CssVarsProvider } = await import('@mui/joy/styles')
  const { fireEvent, render } = await import('@testing-library/react')
  const React = (await import('react')).default
  const { ViewModeToggle } = await import('./ViewModeToggle')

  const calls: string[] = []
  const view = render(
    React.createElement(
      CssVarsProvider,
      null,
      React.createElement(ViewModeToggle, { viewMode: 'list', onViewModeChange: (mode) => calls.push(mode) })
    )
  )

  const listButton = view.getByRole('button', { name: 'List view' })
  const iconButton = view.getByRole('button', { name: 'Icon view' })

  // The active segment reflects the current mode (this is what makes it a buttonset,
  // not two independent buttons).
  assert.equal(listButton.getAttribute('aria-pressed'), 'true')
  assert.equal(iconButton.getAttribute('aria-pressed'), 'false')

  fireEvent.click(iconButton)
  assert.deepEqual(calls, ['icon'])
})
