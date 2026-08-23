/* GetStartedView onboarding-tips tests: the plugin and theme tips always render,
 * while the support-access privacy tip is cloud-only (hidden on self-hosted
 * installs). The plugin tip links only for someone who can MANAGE settings,
 * because the plugins subview redirects to the settings root without it. */
import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { PromptDialogProvider } from '../components/PromptDialogProvider'
import { runtimePolicyContext } from '../lib/runtimePolicy'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { GetStartedView } from './GetStartedView'

const dom = installJsdomGlobals({ url: 'http://localhost/workspaces/alpha' })

globalThis.fetch = async (input: RequestInfo | URL) => {
  const requestUrl = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
  if (requestUrl.pathname === '/api/stats') {
    return new Response(JSON.stringify({
      setupRequired: true,
      hasConnectedBridges: false,
      quickStartCompletedCount: 0,
      quickStartItems: [
        {
          id: 'connect-bridge',
          title: 'Connect a bridge',
          description: 'Connect a bridge so this workspace can discover printers and relay printer activity.',
          complete: false
        }
      ]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`Unhandled request: ${requestUrl.pathname}`)
}

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

function renderView({ selfHosted, canOpenSettings = true }: { selfHosted: boolean, canOpenSettings?: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  })

  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <runtimePolicyContext.Provider value={{ demoMode: false, managedBridge: false, selfHosted }}>
          <PromptDialogProvider>
            <MemoryRouter initialEntries={['/workspaces/alpha']}>
              <GetStartedView canOpenSettings={canOpenSettings} canManageSettings={canOpenSettings} />
            </MemoryRouter>
          </PromptDialogProvider>
        </runtimePolicyContext.Provider>
      </QueryClientProvider>
    </CssVarsProvider>
  )
}

test('GetStartedView shows the theme and support-access tips on cloud installs', async () => {
  const view = renderView({ selfHosted: false })

  const themeTip = await view.findByText('Make it yours')
  assert.equal(themeTip.closest('a')?.getAttribute('href'), '/workspaces/alpha/settings/general')

  const supportTip = view.getByText('Keep it private')
  assert.equal(supportTip.closest('a')?.getAttribute('href'), '/workspaces/alpha/settings/authentication')
})

test('GetStartedView points a new workspace at the plugin catalogue', async () => {
  // Most plugins ship disabled, so this card is the only thing surfacing them
  // outside settings, it must render on self-hosted as well as cloud.
  for (const selfHosted of [false, true]) {
    const view = renderView({ selfHosted })
    const pluginTip = await view.findByText('Add more features')
    assert.equal(pluginTip.closest('a')?.getAttribute('href'), '/workspaces/alpha/settings/plugins')
    cleanup()
  }
})

test('GetStartedView hides the support-access tip on self-hosted installs', async () => {
  const view = renderView({ selfHosted: true })

  await view.findByText('Make it yours')
  assert.equal(view.queryByText('Keep it private'), null)
})

test('GetStartedView renders the tips without links when the viewer cannot open settings', async () => {
  const view = renderView({ selfHosted: false, canOpenSettings: false })

  const themeTip = await view.findByText('Make it yours')
  assert.equal(themeTip.closest('a'), null)
  assert.equal(view.getByText('Keep it private').closest('a'), null)
  // Still shown, just not actionable: the card explains what plugins are for
  // even to someone who cannot turn one on.
  assert.equal(view.getByText('Add more features').closest('a'), null)
})
