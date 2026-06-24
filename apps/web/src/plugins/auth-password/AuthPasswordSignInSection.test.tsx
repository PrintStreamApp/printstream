import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import type { AuthProviderBootstrap } from '@printstream/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { AuthPasswordSignInSection } from './AuthPasswordSignInSection'

const dom = installJsdomGlobals({ url: 'http://localhost/auth' })

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('AuthPasswordSignInSection renders nothing when the password provider is absent', async () => {
  const view = renderWithProviders(
    <AuthPasswordSignInSection authProviders={[]} authBootstrapReady />
  )
  await waitFor(() => {
    assert.equal(view.queryByRole('button', { name: 'Sign In' }), null)
  })
})

test('AuthPasswordSignInSection renders an email/password form when the provider is enabled', async () => {
  const view = renderWithProviders(
    <AuthPasswordSignInSection authProviders={[buildPasswordProvider()]} authBootstrapReady />
  )
  await view.findByRole('button', { name: 'Sign In' })
  assert.ok(view.container.querySelector('input[type="email"]'))
  assert.ok(view.container.querySelector('input[type="password"]'))
})

test('AuthPasswordSignInSection stays hidden while setup is still required', async () => {
  const view = renderWithProviders(
    <AuthPasswordSignInSection authProviders={[buildPasswordProvider()]} authBootstrapReady authSetupRequired />
  )
  await waitFor(() => {
    assert.equal(view.queryByRole('button', { name: 'Sign In' }), null)
  })
})

function buildPasswordProvider(): AuthProviderBootstrap {
  return {
    id: 'auth-password',
    label: 'Password',
    enabled: true,
    methods: ['password'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: true,
      adminUserProvisioning: false,
      adminUserCredentials: true,
      recentVerificationMethods: ['password']
    }
  }
}

function renderWithProviders(element: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  })

  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{element}</MemoryRouter>
      </QueryClientProvider>
    </CssVarsProvider>
  )
}
