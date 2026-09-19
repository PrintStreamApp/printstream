import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'

const dom = installJsdomGlobals()

const React = (await import('react')).default
const { CssVarsProvider } = await import('@mui/joy/styles')
const { default: MenuItem } = await import('@mui/joy/MenuItem')
const { cleanup, fireEvent, render } = await import('@testing-library/react')
const { AppNavigationMenu } = await import('./AppNavigationMenu')

afterEach(() => cleanup())
after(() => dom.window.close())

test('the app navigation menu exposes account and secondary destinations', async () => {
  let accountOpenCount = 0
  let workspaceOpenCount = 0
  const view = render(
    <CssVarsProvider>
      <AppNavigationMenu
        accountLabel="Test User"
        accountIcon={<span data-testid="account-icon" />}
        onOpenAccount={() => {
          accountOpenCount += 1
        }}
        workspaceActionLabel="Switch workspace"
        workspaceContextLabel="Alpha workspace"
        workspaceActionIcon={<span data-testid="workspace-icon" />}
        onOpenWorkspaceChooser={() => {
          workspaceOpenCount += 1
        }}
        actions={(
          <>
            <MenuItem>Help &amp; feedback</MenuItem>
            <MenuItem>Settings</MenuItem>
          </>
        )}
      />
    </CssVarsProvider>
  )

  fireEvent.click(view.getByRole('button', { name: 'More' }))
  const accountItem = await view.findByRole('menuitem', { name: /Account Test User/ })
  assert.ok(accountItem.contains(view.getByTestId('account-icon')))
  assert.ok(view.getByRole('menuitem', { name: 'Help & feedback' }))
  assert.ok(view.getByRole('menuitem', { name: 'Settings' }))
  const workspaceItem = view.getByRole('menuitem', { name: /Switch workspace Alpha workspace/ })
  assert.ok(workspaceItem.contains(view.getByTestId('workspace-icon')))

  fireEvent.click(workspaceItem)
  assert.equal(workspaceOpenCount, 1)

  fireEvent.click(view.getByRole('button', { name: 'More' }))
  fireEvent.click(await view.findByRole('menuitem', { name: /Account Test User/ }))
  assert.equal(accountOpenCount, 1)
})
