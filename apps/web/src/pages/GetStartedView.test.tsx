/* GetStartedView onboarding-tips tests: the theme tip always renders, while the
 * support-access privacy tip is cloud-only (hidden on self-hosted installs). */
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
})
