/**
 * Shared harness for the auth profile/editor component tests (split out of the former
 * 2,900-line authProfileEditors.test.tsx). Importing this module installs the jsdom environment,
 * registers the built-in plugins, and wires a recording `fetch` mock plus the test lifecycle hooks;
 * the split `*.test.tsx` files only contain `test(...)` blocks and pull the factories/mocks from here.
 *
 * Fetch is driven through a holder object (`fetchMock.impl`) rather than a bare `let`, because ESM
 * import bindings are read-only — a split file sets `fetchMock.impl = ...` to script a response, and
 * inspects the recorded calls via the exported `fetchCalls` array (reset after each test).
 */
import { after, afterEach, before } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import type { JSDOM } from 'jsdom'
import type { AuthBootstrap, AuthManagementStatus, AuthUserResponse } from '@printstream/shared'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { registerBuiltinPlugins } from '../plugin/builtin'
import { installJsdomGlobals } from '../test-utils/jsdom'

export type FetchCall = {
  method: string
  pathname: string
  body: unknown
}

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
  window.history.replaceState({}, '', '/account')
})

after(() => {
  dom.window.close()
})

export function buildBootstrap(): AuthBootstrap {
  return {
    authEnabled: true,
    platformAuthEnabled: true,
    setupRequired: false,
    tenant: null,
    memberTenants: [],
    availableTenants: [],
    tenantHasConnectedBridges: false,
    providers: [{
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
    }],
    actor: { type: 'user', userId: 'user-1', email: 'member@example.com', displayName: 'Member', isPlatformUser: false },
    permissions: [],
    capabilities: {
      canViewAuth: true,
      canManageAuthProviders: true,
      canManageSettings: true,
      canManageSupportAccess: true,
      canManageTenants: true,
      canManagePlugins: true,
      canViewLogs: true
    },
    runtimePolicy: { demoMode: false, managedBridge: false }
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
      canViewUserPasskeys: true,
      canEditUserPasskeys: true,
      canRevokeUserPasskeys: true,
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
    counts: {
      users: 0,
      groups: 0,
      serviceAccounts: 0
    },
    ...overrides
  }
}

export function buildProfile(): AuthUserResponse {
  const now = new Date().toISOString()
  return {
    user: {
      id: 'user-1',
      email: 'member@example.com',
      displayName: 'Member',
      loginDisabled: false,
      isPlatformUser: false,
      groups: [],
      passkeyCount: 0,
      createdAt: now,
      updatedAt: now
    }
  }
}

export function renderWithProviders(element: React.ReactElement, options?: { initialEntries?: string[] }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  })

  return render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={options?.initialEntries ?? ['/account']}>
          {element}
        </MemoryRouter>
      </QueryClientProvider>
    </CssVarsProvider>
  )
}

export function parseRequestBody(body: RequestInit['body']): unknown {
  if (typeof body !== 'string') {
    return body ?? null
  }

  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  })
}
