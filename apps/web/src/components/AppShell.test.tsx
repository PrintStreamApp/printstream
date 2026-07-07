import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CssVarsProvider } from '@mui/joy/styles'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { AppShell, type ShellTab } from './AppShell'

const dom = installJsdomGlobals({ url: 'http://localhost/printers' })

const tabs: ReadonlyArray<ShellTab<'/printers'>> = [
  { value: '/printers', label: 'Printers' }
]

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('AppShell opens the workspace chooser from the shell action', () => {
  let openCount = 0
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      workspaceChooserLabel="Alpha workspace"
      workspaceChooserAvailable
      onOpenWorkspaceChooser={() => {
        openCount += 1
      }}
    >
      <div>Body</div>
    </AppShell>
  )

  const chooserButton = view.getByRole('button', {
    name: 'Choose workspace. Current workspace: Alpha workspace'
  })
  assert.ok(view.getByText('Alpha workspace'))
  fireEvent.click(chooserButton)
  assert.equal(openCount, 1)
})

test('AppShell renders a shared workspace label above the current view', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      workspaceLabel="Platform"
    >
      <div>Body</div>
    </AppShell>
  )

  assert.ok(view.getByText('Platform'))
  assert.ok(view.getByText('Body'))
})

test('AppShell renders the mobile nav logo by default when navigation is shown', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
    >
      <div>Body</div>
    </AppShell>
  )

  const logo = view.container.querySelector('img[src="/icon-512.png"]')
  assert.ok(logo)
})

test('AppShell opens home from the logo action', () => {
  let homeOpenCount = 0
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      onLogoClick={() => {
        homeOpenCount += 1
      }}
    >
      <div>Body</div>
    </AppShell>
  )

  const [homeButton] = view.getAllByRole('button', { name: 'PrintStream home' })
  assert.ok(homeButton)
  fireEvent.click(homeButton)
  assert.equal(homeOpenCount, 1)
})

test('AppShell renders an optional content header supplement', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      contentHeaderTrailing={<div>Dev runtime</div>}
    >
      <div>Body</div>
    </AppShell>
  )

  assert.ok(view.getByText('Dev runtime'))
  assert.ok(view.getByText('Body'))
})

test('AppShell renders an optional footer supplement', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      footerTrailing={<div>Dev footer</div>}
    >
      <div>Body</div>
    </AppShell>
  )

  assert.ok(view.getByText('Dev footer'))
  assert.ok(view.getByText('Body'))
})

test('AppShell can render a chooser shell without nav tabs or workspace footer label', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={[]}
      activeTab={'/printers' as const}
      currentPath="/workspaces"
      onTabChange={() => {}}
      showNavigationFrame
      identity={{ primary: 'Test User', secondary: 'user@example.com' }}
    >
      <div>Choose a workspace</div>
    </AppShell>
  )

  assert.equal(view.queryByText('Printers'), null)
  assert.equal(view.queryByText('Workspace'), null)
  assert.equal(view.queryByRole('button', { name: /Choose workspace/i }), null)
  assert.ok(view.getByText('Choose a workspace'))
})

test('AppShell highlights no tab when activeTab is null', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab={null}
      currentPath="/suggestions"
      onTabChange={() => {}}
    >
      <div>Body</div>
    </AppShell>
  )

  for (const tab of view.getAllByRole('tab')) {
    assert.equal(tab.getAttribute('aria-selected'), 'false')
  }
})

test('AppShell renders the signed-in user name as an account button without the email address', () => {
  let openAccountCount = 0
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      onOpenAccount={() => {
        openAccountCount += 1
      }}
      identity={{ primary: 'Test User', secondary: 'user@example.com' }}
    >
      <div>Body</div>
    </AppShell>
  )

  const accountButton = view.getByRole('button', { name: 'Test User' })
  assert.equal(view.queryByText('user@example.com'), null)
  fireEvent.click(accountButton)
  assert.equal(openAccountCount, 1)
})

function renderWithProviders(node: React.ReactElement) {
  return render(
    <CssVarsProvider defaultMode="dark">
      {node}
    </CssVarsProvider>
  )
}