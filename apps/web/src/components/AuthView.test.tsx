/* Auth profile/editor component tests. Shared setup, the recording fetch mock, and the
 * bootstrap/profile factories live in ./authProfileEditors.testkit (split out of the former
 * 2,900-line authProfileEditors.test.tsx). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'
import { AuthView } from '../pages/AuthView'
import { AuthOAuthSignInSection } from '../plugins/auth-oauth/AuthOAuthSignInSection'
import { AuthOAuthProviderSettingsSection } from '../plugins/auth-oauth/AuthOAuthSettingsPanel'
import { buildBootstrap, fetchCalls, fetchMock, jsonResponse, renderWithProviders } from './authProfileEditors.testkit'

test('AuthView requests and verifies a one-time email code on the same page', async () => {
  const user = userEvent.setup({ document: window.document })
  const bootstrap = buildBootstrap()

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'POST /api/plugins/auth-local/email-codes/request':
        return jsonResponse({
          delivered: true,
          expiresAt: '2026-05-02T01:15:00.000Z',
          previewCode: 'ABCD-EFGH'
        })
      case 'POST /api/plugins/auth-local/email-codes/verify':
        return jsonResponse({
          authenticated: true,
          actor: {
            type: 'user',
            userId: 'user-1'
          },
          redirectTo: null
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Sign In' })
  await view.findByRole('button', { name: 'Sign In With Passkey' })
  assert.equal(view.container.querySelector('input[type="email"]'), null)
  const passkeyButton = view.getByRole('button', { name: 'Sign In With Passkey' })
  const emailChoiceButton = view.getByRole('button', { name: 'Use Email' })
  assert.equal(
    passkeyButton.compareDocumentPosition(emailChoiceButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    Node.DOCUMENT_POSITION_FOLLOWING
  )
  await user.click(emailChoiceButton)

  await waitFor(() => {
    assert.ok(view.container.querySelector('input[type="email"]'))
  })
  const authEmailInput = view.container.querySelector('input[type="email"]') as HTMLInputElement
  await user.type(authEmailInput, 'member@example.com')
  await waitFor(() => {
    assert.equal(authEmailInput?.value, 'member@example.com')
    assert.equal((view.getByRole('button', { name: 'Email Me A Code' }) as HTMLButtonElement).disabled, false)
  })
  const requestCodeButton = view.getByRole('button', { name: 'Email Me A Code' }) as HTMLButtonElement
  assert.equal(requestCodeButton.getAttribute('type'), 'button')
  await user.click(requestCodeButton)

  await waitFor(() => {
    const request = fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/request')
    assert.ok(request)
    assert.equal((request.body as { timeZone?: string } | undefined)?.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  await view.findByDisplayValue('ABCD-EFGH')
  const verifyCodeInput = document.body.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement | null
  assert.ok(verifyCodeInput)
  await waitFor(() => {
    assert.equal(document.activeElement, verifyCodeInput)
  })
  const resendCodeButton = view.getByRole('button', { name: 'Send another code' }) as HTMLButtonElement
  assert.equal(resendCodeButton.getAttribute('type'), 'button')
  await user.click(resendCodeButton)
  await waitFor(() => {
    const resendRequests = fetchCalls.filter((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/request')
    assert.equal(resendRequests.length, 2)
  })
  await user.type(verifyCodeInput, 'ABCD-EFGH')
  const verifyCodeButton = view.getByRole('button', { name: 'Verify code' }) as HTMLButtonElement | null
  assert.ok(verifyCodeButton)
  assert.equal(verifyCodeButton.getAttribute('type'), 'submit')
  await waitFor(() => {
    assert.equal(verifyCodeButton.disabled, false)
  })
  await user.click(verifyCodeButton)

  await waitFor(() => {
    assert.equal(
      fetchCalls.some((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/verify'),
      true
    )
  })
})

test('AuthView opens the email-code form from an invite link and verifies against the invited tenant', async () => {
  const user = userEvent.setup({ document: window.document })
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(buildBootstrap())
      case 'POST /api/plugins/auth-local/email-codes/verify':
        return jsonResponse({
          authenticated: true,
          actor: {
            type: 'user',
            userId: 'user-1'
          },
          redirectTo: '/account'
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />, {
    initialEntries: ['/auth?invite=1&authMode=email-code&email=member%40example.com&tenantId=tenant-1&tenantName=Alpha']
  })

  await view.findByRole('heading', { name: 'Sign In' })
  await view.findByText('You were invited to Alpha. Enter the one-time code from your email to continue.')

  const emailInput = document.body.querySelector('input[autocomplete="email"]') as HTMLInputElement | null
  const codeInput = document.body.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement | null
  assert.ok(emailInput)
  assert.ok(codeInput)
  assert.equal(emailInput.value, 'member@example.com')

  await user.type(codeInput, 'ABCD-EFGH')
  await waitFor(() => {
    assert.equal(codeInput.value, 'ABCD-EFGH')
  })
  const inviteVerifyCodeButton = view.container.querySelector('[aria-label="Verify code"]') as HTMLElement | null
  assert.ok(inviteVerifyCodeButton)
  await waitFor(() => {
    assert.equal((inviteVerifyCodeButton as HTMLButtonElement).disabled, false)
  })
  await user.click(inviteVerifyCodeButton)

  await waitFor(() => {
    const request = fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/verify')
    assert.equal((request?.body as { email?: string } | undefined)?.email, 'member@example.com')
    assert.equal((request?.body as { tenantId?: string } | undefined)?.tenantId, 'tenant-1')
  })
})

test('AuthView hides auth-local sign-in controls when another provider is active instead', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          providers: [{
            id: 'auth-sso',
            label: 'SSO',
            enabled: true,
            methods: ['oauth'],
            capabilities: {
              signIn: true,
              setup: false,
              accountSecurity: false,
              adminUserProvisioning: false,
              adminUserCredentials: false,
              recentVerificationMethods: []
            }
          }]
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await waitFor(() => {
    assert.equal(fetchCalls.some((call) => call.method === 'GET' && call.pathname === '/api/auth/bootstrap'), true)
  })
  await waitFor(() => {
    assert.equal(view.queryByRole('heading', { name: 'Sign In' }) !== null, true)
  })
  assert.equal(view.queryByRole('button', { name: 'Sign In With Passkey' }), null)
  assert.equal(view.queryByRole('button', { name: 'Email Me A Code' }), null)
})

test('AuthView hides auth-local sign-in controls during first-run setup before the initial admin exists', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          setupRequired: true,
          actor: { type: 'anonymous', isPlatformUser: false },
          providers: [{
            id: 'auth-local',
            label: 'Local auth',
            enabled: true,
            methods: ['passkey', 'email-code'],
            setupRequired: true,
            capabilities: {
              signIn: true,
              setup: true,
              accountSecurity: true,
              adminUserProvisioning: true,
              adminUserCredentials: true,
              recentVerificationMethods: ['passkey', 'email-code']
            }
          }]
        })
      case 'GET /api/plugins/auth-local/status':
        return jsonResponse({
          setupRequired: true,
          sessionDuration: 'month',
          permissions: [],
          permissionDefinitions: [],
          initialAdminEmail: null,
          counts: {
            users: 0,
            groups: 0,
            serviceAccounts: 0,
            passkeys: 0
          }
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Set up sign in' })
  await view.findByText('Local Auth is enabled. Initial admin setup and sign-in are ready here.')
  await view.findByText('Create initial admin')
  assert.equal(view.queryByRole('button', { name: 'Sign In With Passkey' }), null)
  assert.equal(view.queryByRole('button', { name: 'Email Me A Code' }), null)
})

test('AuthView shows provider toggles after auth reset disables every platform provider', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          setupRequired: false,
          actor: { type: 'anonymous', isPlatformUser: false },
          providers: [{
            id: 'auth-local',
            label: 'Local auth',
            enabled: false,
            methods: ['passkey', 'email-code'],
            setupRequired: true,
            capabilities: {
              signIn: true,
              setup: true,
              accountSecurity: true,
              adminUserProvisioning: true,
              adminUserCredentials: true,
              recentVerificationMethods: ['passkey', 'email-code']
            }
          }]
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Set up sign in' })
  await view.findByText('Local Auth')
  await view.findByText('Enable Local Auth before creating the first admin or allowing local sign-in.')
  assert.equal(view.queryByRole('button', { name: 'Sign In With Passkey' }), null)
  assert.equal(view.queryByRole('button', { name: 'Email Me A Code' }), null)
})

test('AuthView shows the OAuth toggle on the setup screen without duplicating the configuration form', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          setupRequired: true,
          actor: { type: 'anonymous', isPlatformUser: false },
          providers: [{
            id: 'auth-oauth',
            label: 'Single Sign-On',
            enabled: true,
            methods: ['oauth'],
            setupRequired: true,
            capabilities: {
              signIn: true,
              setup: true,
              accountSecurity: false,
              adminUserProvisioning: false,
              adminUserCredentials: false,
              recentVerificationMethods: []
            }
          }]
        })
      case 'GET /api/plugins/auth-oauth/config':
        return jsonResponse({
          configured: false,
          displayName: 'Single Sign-On',
          issuerUrl: null,
          clientId: null,
          clientSecretConfigured: false,
          scopes: ['openid', 'profile', 'email']
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Set up sign in' })
  await view.findByText('Single Sign-On is enabled and uses the configuration shown below.')
  await waitFor(() => {
    assert.equal(view.queryAllByRole('button', { name: 'Save Single Sign-On settings' }).length, 1)
  })
})

test('AuthView exits stale setup mode once live local-auth status reports email verification is complete', async () => {
  let bootstrapRequests = 0

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap': {
        bootstrapRequests += 1
        if (bootstrapRequests === 1) {
          return jsonResponse({
            ...buildBootstrap(),
            authEnabled: false,
            setupRequired: true,
            actor: { type: 'anonymous', isPlatformUser: false },
            providers: [{
              id: 'auth-local',
              label: 'Local auth',
              enabled: true,
              methods: ['passkey', 'email-code'],
              setupRequired: true,
              capabilities: {
                signIn: true,
                setup: true,
                accountSecurity: true,
                adminUserProvisioning: true,
                adminUserCredentials: true,
                recentVerificationMethods: ['passkey', 'email-code']
              }
            }]
          })
        }

        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: true,
          setupRequired: false,
          actor: { type: 'anonymous', isPlatformUser: false },
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
          }]
        })
      }
      case 'GET /api/plugins/auth-local/status':
        return jsonResponse({
          setupRequired: false,
          sessionDuration: 'month',
          permissions: [],
          permissionDefinitions: [],
          initialAdminEmail: null,
          counts: {
            users: 1,
            groups: 4,
            serviceAccounts: 0,
            passkeys: 0
          }
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Set up sign in' })
  await waitFor(() => {
    assert.equal(bootstrapRequests >= 2, true)
  })
  await view.findByRole('heading', { name: 'Sign In' })
  assert.ok(view.getByRole('button', { name: 'Use Email' }))
})

test('AuthOAuthProviderSettingsSection hides the inline OAuth form while the provider is disabled', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    throw new Error(`Unexpected request: ${key}`)
  }

  const view = renderWithProviders(
    <AuthOAuthProviderSettingsSection
      authBootstrapReady
      canManageAuthProviders
      authProviders={[{
        id: 'auth-oauth',
        label: 'Single Sign-On',
        enabled: false,
        methods: ['oauth'],
        setupRequired: true,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: false,
          adminUserProvisioning: false,
          adminUserCredentials: false,
          recentVerificationMethods: []
        }
      }]}
    />
  )

  await view.findByText('Enable Single Sign-On to configure an OpenID Connect provider.')
  assert.equal(view.queryByRole('button', { name: 'Save Single Sign-On settings' }), null)
  assert.equal(view.queryByLabelText('Provider label'), null)
})

test('AuthOAuthSignInSection stays available during setup once Single Sign-On is configured', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/plugins/auth-oauth/config':
        return jsonResponse({
          configured: true,
          displayName: 'Single Sign-On',
          issuerUrl: 'https://issuer.example',
          clientId: 'client-123',
          clientSecretConfigured: true,
          scopes: ['openid', 'profile', 'email']
        })
      default:
        throw new Error(`Unexpected request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthOAuthSignInSection
      authBootstrapReady
      authProviders={[{
        id: 'auth-oauth',
        label: 'Single Sign-On',
        enabled: true,
        methods: ['oauth'],
        setupRequired: true,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: false,
          adminUserProvisioning: false,
          adminUserCredentials: false,
          recentVerificationMethods: []
        }
      }]}
    />
  )

  await view.findByText('Finish Single Sign-On setup by completing the first verified admin sign-in.')
  assert.ok(view.getByRole('button', { name: 'Continue with Single Sign-On' }))
})

test('AuthOAuthSignInSection uses the current workspace auth scope instead of cached platform config', async () => {
  let fetchCount = 0
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/plugins/auth-oauth/config':
        fetchCount += 1
        return jsonResponse({
          configured: true,
          displayName: 'Tenant SSO',
          issuerUrl: 'https://tenant-issuer.example',
          clientId: 'tenant-client',
          clientSecretConfigured: true,
          scopes: ['openid', 'profile', 'email']
        })
      default:
        throw new Error(`Unexpected request: ${key}`)
    }
  }

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Number.POSITIVE_INFINITY
      },
      mutations: { retry: false }
    }
  })
  queryClient.setQueryData(['auth-oauth-config', 'platform'], {
    configured: false,
    displayName: 'Platform SSO',
    issuerUrl: null,
    clientId: null,
    clientSecretConfigured: false,
    scopes: ['openid', 'profile', 'email']
  })

  const view = render(
    <CssVarsProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/account']}>
          <AuthOAuthSignInSection
            authBootstrapReady
            authScopeKey="tenant-1"
            authProviders={[{
              id: 'auth-oauth',
              label: 'Tenant SSO',
              enabled: true,
              methods: ['oauth'],
              setupRequired: true,
              capabilities: {
                signIn: true,
                setup: true,
                accountSecurity: false,
                adminUserProvisioning: false,
                adminUserCredentials: false,
                recentVerificationMethods: []
              }
            }]}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </CssVarsProvider>
  )

  await view.findByRole('button', { name: 'Continue with Tenant SSO' })
  assert.equal(fetchCount, 1)
})

test('AuthView finishes local setup after the initial admin verifies the emailed code', async () => {
  let authBootstrapRequests = 0
  let localAuthStatusRequests = 0

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap': {
        authBootstrapRequests += 1
        if (authBootstrapRequests >= 3) {
          return jsonResponse({
            ...buildBootstrap(),
            authEnabled: true,
            setupRequired: false,
            actor: { type: 'user', userId: 'user-1', isPlatformUser: true },
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
            }]
          })
        }

        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          setupRequired: true,
          actor: { type: 'anonymous', isPlatformUser: false },
          providers: [{
            id: 'auth-local',
            label: 'Local auth',
            enabled: true,
            methods: ['passkey', 'email-code'],
            setupRequired: true,
            capabilities: {
              signIn: true,
              setup: true,
              accountSecurity: true,
              adminUserProvisioning: true,
              adminUserCredentials: true,
              recentVerificationMethods: ['passkey', 'email-code']
            }
          }]
        })
      }
      case 'GET /api/plugins/auth-local/status': {
        localAuthStatusRequests += 1
        if (localAuthStatusRequests === 1) {
          return jsonResponse({
            setupRequired: true,
            sessionDuration: 'month',
            permissions: [],
            permissionDefinitions: [],
            initialAdminEmail: null,
            counts: {
              users: 0,
              groups: 0,
              serviceAccounts: 0,
              passkeys: 0
            }
          })
        }

        return jsonResponse({
          setupRequired: localAuthStatusRequests < 3,
          sessionDuration: 'month',
          permissions: [],
          permissionDefinitions: [],
          initialAdminEmail: localAuthStatusRequests < 3 ? 'admin@example.com' : null,
          counts: {
            users: 1,
            groups: 4,
            serviceAccounts: 0,
            passkeys: 0
          }
        })
      }
      case 'POST /api/plugins/auth-local/bootstrap/admin':
        return jsonResponse({
          user: {
            id: 'user-1',
            email: 'admin@example.com',
            displayName: 'Primary Admin',
            createdAt: new Date('2026-05-01T00:00:00.000Z').toISOString()
          },
          group: {
            id: 'platform-group-admin',
            key: 'admin',
            name: 'Admin'
          },
          invite: {
            delivered: true,
            expiresAt: new Date('2026-05-01T00:15:00.000Z').toISOString(),
            previewCode: 'ABCD-EFGH'
          },
          setupRequired: true
        })
      case 'POST /api/plugins/auth-local/email-codes/request':
        return jsonResponse({
          delivered: true,
          requiresTenantSelection: false,
          tenants: [],
          expiresAt: new Date('2026-05-01T00:15:00.000Z').toISOString(),
          previewCode: 'ABCD-EFGH'
        })
      case 'POST /api/plugins/auth-local/email-codes/verify':
        return jsonResponse({
          authenticated: true,
          actor: {
            type: 'user',
            userId: 'user-1'
          },
          redirectTo: null
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Set up sign in' })
  await view.findByText('Create initial admin')
  fireEvent.change(view.getByPlaceholderText('admin@example.com'), { target: { value: 'admin@example.com' } })
  fireEvent.change(view.getByPlaceholderText('Primary admin'), { target: { value: 'Primary Admin' } })
  fireEvent.click(view.getByRole('button', { name: 'Create initial admin' }))

  await view.findByText('Check your email for the code, then enter it here to continue.')
  await view.findByDisplayValue('ABCD-EFGH')
  const verificationEmailInput = view.container.querySelector('input[autocomplete="email"]') as HTMLInputElement
  assert.equal(verificationEmailInput.value, 'admin@example.com')
  fireEvent.input(verificationEmailInput, { target: { value: 'fixed@example.com' } })
  assert.equal(verificationEmailInput.value, 'fixed@example.com')

  fireEvent.click(view.getByRole('button', { name: 'Resend verification code' }))
  fireEvent.change(view.container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement, { target: { value: 'ABCD-EFGH' } })
  fireEvent.click(view.getByRole('button', { name: 'Verify code' }))

  await view.findByRole('heading', { name: 'Sign In' })
  assert.ok(view.getByRole('button', { name: 'Use Email' }))
  await waitFor(() => {
    const resendRequest = fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/request')
    assert.deepEqual(resendRequest?.body, {
      email: 'fixed@example.com',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    })
    const verifyRequest = fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/verify')
    assert.equal((verifyRequest?.body as { email?: string } | undefined)?.email, 'fixed@example.com')
    assert.equal(
      fetchCalls.some((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/verify'),
      true
    )
  })
})

test('AuthView does not render the tenant setup flow when tenant auth still needs onboarding', async () => {
  let authBootstrapRequests = 0

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap': {
        authBootstrapRequests += 1
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          platformAuthEnabled: true,
          setupRequired: true,
          tenant: {
            id: 'tenant-1',
            slug: 'alpha',
            name: 'Alpha'
          },
          actor: { type: authBootstrapRequests >= 3 ? 'user' : 'anonymous', isPlatformUser: false },
          providers: [{
            id: 'auth-local',
            label: 'Local auth',
            enabled: true,
            methods: ['passkey', 'email-code'],
            setupRequired: true,
            capabilities: {
              signIn: true,
              setup: true,
              accountSecurity: true,
              adminUserProvisioning: true,
              adminUserCredentials: true,
              recentVerificationMethods: ['passkey', 'email-code']
            }
          }]
        })
      }
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<AuthView />)

  await view.findByRole('heading', { name: 'Sign In' })
  assert.equal(view.queryByText('Invite the first workspace admin, then verify the one-time code here to finish sign-in setup.'), null)
  assert.equal(view.queryByRole('button', { name: 'Invite initial workspace admin' }), null)
  assert.equal(fetchCalls.some((call) => call.pathname === '/api/plugins/auth-local/status'), false)
  assert.equal(fetchCalls.some((call) => call.pathname === '/api/plugins/auth-local/bootstrap/admin'), false)
  assert.equal(authBootstrapRequests > 0, true)
})
