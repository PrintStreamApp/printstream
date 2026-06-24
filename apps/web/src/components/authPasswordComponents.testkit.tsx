/**
 * Public auth component-test harness, built around the open-source `auth-password`
 * provider (the auth-local-coupled harness + its tests are cloud-only and excluded
 * from the public snapshot). Installs jsdom, registers the built-in web plugins
 * (which include auth-password), and wires a recording `fetch` mock. Split test
 * files import the factories/mocks from here and only contain `test(...)` blocks.
 */
import { after, afterEach, before } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import type { JSDOM } from 'jsdom'
import type { AuthBootstrap, AuthManagementStatus, AuthProviderBootstrap, AuthUserResponse } from '@printstream/shared'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { registerBuiltinPlugins } from '../plugin/builtin'
import { runtimePolicyContext, type RuntimePolicyValue } from '../lib/runtimePolicy'
import { installJsdomGlobals } from '../test-utils/jsdom'

export type FetchCall = { method: string; pathname: string; body: unknown }

export const fetchCalls: FetchCall[] = []
export const fetchMock: { impl: (url: URL, init: RequestInit) => Promise<Response> } = {
  impl: async () => {
    throw new Error('fetch mock not configured')
  }
}

let dom: JSDOM

before(() => {
  registerBuiltinPlugins()
  dom = installJsdomGlobals({ url: 'http://localhost/account' })
  const { window } = dom

  Object.assign(globalThis, {
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage
  })
  Object.defineProperty(window.HTMLElement.prototype, 'attachEvent', { configurable: true, value: () => {} })
  Object.defineProperty(window.HTMLElement.prototype, 'detachEvent', { configurable: true, value: () => {} })
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true })

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = new URL(typeof input === 'string' ? input : input.toString(), 'http://localhost')
    const requestInit = init ?? {}
    fetchCalls.push({
      method: (requestInit.method ?? 'GET').toUpperCase(),
      pathname: requestUrl.pathname,
      body: parseRequestBody(requestInit.body)
    })
    return fetchMock.impl(requestUrl, requestInit)
  }
})

afterEach(() => {
  cleanup()
  fetchCalls.length = 0
  fetchMock.impl = async () => {
    throw new Error('fetch mock not configured')
  }
  dom.window.history.replaceState({}, '', '/account')
})

after(() => {
  dom.window.close()
})

export function buildPasswordProvider(overrides: Partial<AuthProviderBootstrap> = {}): AuthProviderBootstrap {
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
    },
    ...overrides
  }
}

/** Self-hosted (OSS) bootstrap: single workspace, password provider, no platform auth. */
export function buildBootstrap(overrides: Partial<AuthBootstrap> = {}): AuthBootstrap {
  return {
    authEnabled: true,
    platformAuthEnabled: false,
    setupRequired: false,
    tenant: { id: 'tenant-1', slug: 'default', name: 'My Workspace' },
    memberTenants: [],
    availableTenants: [],
    tenantHasConnectedBridges: false,
    providers: [buildPasswordProvider()],
    actor: { type: 'user', userId: 'user-1', email: 'admin@example.com', displayName: 'Admin', isPlatformUser: false },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: true,
      canManageSettings: true,
      canManageSupportAccess: true,
      canManageTenants: false,
      canManagePlugins: true,
      canViewLogs: true
    },
    runtimePolicy: { demoMode: false, managedBridge: false, selfHosted: true },
    ...overrides
  }
}

export function buildManagementStatus(overrides: Partial<AuthManagementStatus> = {}): AuthManagementStatus {
  return {
    sessionDuration: 'day',
    permissionDefinitions: [],
    assignablePermissions: [],
    capabilities: {
      canViewUsers: true,
      canCreateUsers: true,
      canEditUsers: true,
      canChangeUserEmail: false,
      canDisableUserSignIn: true,
      canDeleteUsers: true,
      canAssignUserRoles: true,
      canViewUserSessions: true,
      canRevokeUserSessions: true,
      canViewUserPasskeys: false,
      canEditUserPasskeys: false,
      canRevokeUserPasskeys: false,
      canViewRoles: true,
      canCreateRoles: true,
      canEditRoles: true,
      canDeleteRoles: true,
      canAssignRolePermissions: true,
      canViewServiceAccounts: true,
      canCreateServiceAccounts: true,
      canEditServiceAccounts: true,
      canRevokeServiceAccounts: true,
      canAssignServiceAccountRoles: true,
      canManageSessionPolicy: true,
      canManageSupportAccess: true
    },
    counts: { users: 1, groups: 1, serviceAccounts: 0 },
    ...overrides
  }
}

export function buildProfile(): AuthUserResponse {
  const now = new Date().toISOString()
  return {
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      displayName: 'Admin',
      loginDisabled: false,
      isPlatformUser: false,
      groups: [],
      passkeyCount: 0,
      createdAt: now,
      updatedAt: now
    }
  }
}

export function renderWithProviders(
  element: React.ReactElement,
  options?: { initialEntries?: string[]; runtimePolicy?: Partial<RuntimePolicyValue> }
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  })
  // Mirror App.tsx, which feeds runtimePolicy from the bootstrap. Default to the
  // self-hosted (OSS) shape since these tests cover the open-source build.
  const runtimePolicy: RuntimePolicyValue = {
    demoMode: false,
    managedBridge: false,
    selfHosted: true,
    ...options?.runtimePolicy
  }
  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <runtimePolicyContext.Provider value={runtimePolicy}>
          <MemoryRouter initialEntries={options?.initialEntries ?? ['/account']}>
            {element}
          </MemoryRouter>
        </runtimePolicyContext.Provider>
      </QueryClientProvider>
    </CssVarsProvider>
  )
}

export function parseRequestBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') return body ?? null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
