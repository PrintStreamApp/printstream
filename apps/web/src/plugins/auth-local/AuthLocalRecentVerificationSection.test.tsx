import assert from 'node:assert/strict'
import { after, afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import type { AuthBootstrap, AuthProviderBootstrap, AuthUserPasskeyListResponse } from '@printstream/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, waitFor } from '@testing-library/react'
import React from 'react'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { AuthLocalRecentVerificationSection } from './AuthLocalRecentVerificationSection'

const dom = installJsdomGlobals({ url: 'http://localhost/account' })

let fetchImpl: (url: URL, init: RequestInit) => Promise<Response> = async () => {
  throw new Error('fetch mock not configured')
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const requestUrl = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
  return fetchImpl(requestUrl, init ?? {})
}

afterEach(() => {
  cleanup()
})

after(() => {
  dom.window.close()
})

test('AuthLocalRecentVerificationSection hides passkey verification when the signed-in user has no passkeys', async () => {
  const bootstrap = buildBootstrap()
  const passkeys: AuthUserPasskeyListResponse = { passkeys: [] }

  fetchImpl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse(passkeys)
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthLocalRecentVerificationSection authProviders={[buildLocalAuthProvider()]} email="member@example.com" />
  )

  await view.findByRole('button', { name: 'Email verification code' })
  await waitFor(() => {
    assert.equal(view.queryByRole('button', { name: 'Verify with passkey' }), null)
  })
})

test('AuthLocalRecentVerificationSection shows passkey verification when the signed-in user has a passkey', async () => {
  const bootstrap = buildBootstrap()
  const now = '2026-05-06T12:00:00.000Z'
  const passkeys: AuthUserPasskeyListResponse = {
    passkeys: [{
      id: 'passkey-1',
      nickname: 'Laptop',
      aaguid: null,
      transports: ['internal'],
      backedUp: true,
      lastUsedAt: now,
      createdAt: now,
      updatedAt: now
    }]
  }

  fetchImpl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse(passkeys)
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthLocalRecentVerificationSection authProviders={[buildLocalAuthProvider()]} email="member@example.com" />
  )

  await view.findByRole('button', { name: 'Verify with passkey' })
})

test('AuthLocalRecentVerificationSection tolerates providers without recent verification methods', async () => {
  fetchImpl = async () => {
    throw new Error('No requests expected')
  }

  const malformedProvider = {
    ...buildLocalAuthProvider(),
    capabilities: {
      ...buildLocalAuthProvider().capabilities,
      recentVerificationMethods: undefined
    }
  } as unknown as AuthProviderBootstrap

  const view = renderWithProviders(
    <AuthLocalRecentVerificationSection authProviders={[malformedProvider]} email="member@example.com" />
  )

  await waitFor(() => {
    assert.equal(view.queryByRole('button', { name: 'Verify with passkey' }), null)
    assert.equal(view.queryByRole('button', { name: 'Email verification code' }), null)
  })
})

function buildBootstrap(overrides: Partial<AuthBootstrap> = {}): AuthBootstrap {
  const { memberTenants = [], availableTenants = [], ...rest } = overrides

  return {
    authEnabled: true,
    platformAuthEnabled: true,
    setupRequired: false,
    tenant: null,
    tenantHasConnectedBridges: false,
    providers: [buildLocalAuthProvider()],
    actor: {
      type: 'user',
      userId: 'user-1',
      email: 'member@example.com',
      isPlatformUser: false
    },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: false,
      canManageSettings: false,
      canManageSupportAccess: false,
      canManageTenants: false,
      canManagePlugins: false,
      canViewLogs: false
    },
    runtimePolicy: { demoMode: false },
    ...rest,
    memberTenants,
    availableTenants
  }
}

function buildLocalAuthProvider(): AuthProviderBootstrap {
  return {
    id: 'auth-local',
    label: 'Local auth',
    enabled: true,
    methods: ['passkey', 'email-code'],
    setupRequired: false,
    capabilities: {
      signIn: true,
      setup: true,
      accountSecurity: true,
      adminUserProvisioning: true,
      adminUserCredentials: true,
      recentVerificationMethods: ['passkey', 'email-code']
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
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
        {element}
      </QueryClientProvider>
    </CssVarsProvider>
  )
}