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

test('AppShell removes the workspace name from the footer and exposes switching from the nav menu', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      workspaceChooserLabel="Alpha workspace"
      workspaceChooserAvailable
      onOpenWorkspaceChooser={() => {}}
    >
      <div>Body</div>
    </AppShell>
  )

  assert.equal(view.queryByText('Alpha workspace'), null)
  assert.equal(view.queryByRole('button', { name: /Alpha workspace/ }), null)
  assert.equal(view.getAllByRole('button', { name: 'More' }).length, 2)
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

// The shell renders the logo once, in the desktop header. The mobile bottom tab bar used to
// carry a second copy; it ate ~54px of a 375px dock and duplicated the same home affordance.
test('AppShell renders the logo only in the desktop header, not the mobile tab bar', () => {
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

  assert.equal(view.container.querySelectorAll('img[src="/icon-512.png"]').length, 1)
  assert.equal(view.getAllByRole('button', { name: 'PrintStream home' }).length, 1)
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

test('AppShell keeps app-wide identity and actions out of the footer', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      onOpenAccount={() => {}}
      identity={{ primary: 'Test User', secondary: 'user@example.com' }}
      identityIcon={<span data-testid="identity-icon" />}
      workspaceChooserLabel="Home"
      workspaceChooserIcon={<span data-testid="workspace-switcher-icon" />}
      workspaceChooserAvailable
      onOpenWorkspaceChooser={() => {}}
      navigationMenuActions={(
        <>
          <div role="menuitem">Help &amp; feedback</div>
          <div role="menuitem">Suggestions</div>
          <div role="menuitem">Billing and licensing</div>
          <div role="menuitem">Settings</div>
        </>
      )}
    >
      <div>Body</div>
    </AppShell>
  )

  assert.equal(view.container.querySelector('[data-footer-group="workspace-identity"]'), null)
  assert.equal(view.queryByText('Home'), null)
  assert.equal(view.container.querySelector('[data-footer-group="actions"]'), null)
  assert.equal(view.queryByText('Test User'), null)

  const moreButtons = view.getAllByRole('button', { name: 'More' })
  assert.equal(moreButtons.length, 2)
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
  assert.equal(view.queryByRole('button', { name: /Switch workspace/i }), null)
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

test('AppShell offers the navigation menu for a signed-in user without exposing the email address', () => {
  const view = renderWithProviders(
    <AppShell
      tabs={tabs}
      activeTab="/printers"
      currentPath="/printers"
      onTabChange={() => {}}
      onOpenAccount={() => {}}
      identity={{ primary: 'Test User', secondary: 'user@example.com' }}
    >
      <div>Body</div>
    </AppShell>
  )

  assert.equal(view.getAllByRole('button', { name: 'More' }).length, 2)
  assert.equal(view.queryByText('user@example.com'), null)
})

function renderWithProviders(node: React.ReactElement) {
  return render(
    <CssVarsProvider defaultMode="dark">
      {node}
    </CssVarsProvider>
  )
}
