/* Auth profile/editor component tests. Shared setup, the recording fetch mock, and the
 * bootstrap/profile factories live in ./authProfileEditors.testkit (split out of the former
 * 2,900-line authProfileEditors.test.tsx). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fireEvent, waitFor } from '@testing-library/react'
import type { AuthSessionListResponse } from '@printstream/shared'
import React from 'react'
import { CurrentAccountPanel } from './CurrentAccountPanel'
import { PlatformAuthSummarySection } from './PlatformAuthSummarySection'
import { buildBootstrap, buildProfile, fetchCalls, fetchMock, jsonResponse, renderWithProviders } from './authProfileEditors.testkit'

test('CurrentAccountPanel opens an on-demand verification dialog and requests an account-scoped email code when passkey revoke needs a fresh session', async () => {
  const now = Date.now()
  const bootstrap = buildBootstrap()
  const sessions: AuthSessionListResponse = {
    sessions: [{
      id: 'session-1',
      current: true,
      userAgent: 'Test Browser',
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    }]
  }
  const profile = buildProfile()

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/auth/sessions':
        return jsonResponse(sessions)
      case 'GET /api/auth/me':
        return jsonResponse(profile)
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse({
          passkeys: [{
            id: 'passkey-1',
            nickname: 'Desk laptop',
            aaguid: null,
            transports: ['internal'],
            backedUp: true,
            lastUsedAt: null,
            createdAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
            updatedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString()
          }]
        })
      case 'POST /api/plugins/auth-local/passkeys/passkey-1/revoke':
        return jsonResponse({ error: 'Verify your identity again to continue.' }, 403)
      case 'POST /api/plugins/auth-local/email-codes/request':
        return jsonResponse({
          delivered: true,
          expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
          previewCode: 'ABCD-EFGH'
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />)

  await view.findByRole('button', { name: 'Save display name' })
  assert.equal(view.queryByRole('button', { name: 'Save profile' }), null)
  assert.equal(view.queryByText('Update the name shown throughout your account. Provider-owned sign-in methods live in the account security section below.'), null)
  assert.equal(view.queryByText('Leave display name blank to fall back to your email address.'), null)
  await view.findByRole('button', { name: 'Revoke' })
  assert.equal(view.queryByText('1 passkey'), null)
  assert.equal(view.queryByText(/^Transport:/), null)
  assert.equal(view.queryByText(/^Authenticator ID:/), null)
  fireEvent.click(view.getByRole('button', { name: 'Revoke' }))

  await view.findByText('Verify to revoke this passkey')
  assert.equal(document.body.querySelector('input[autocomplete="one-time-code"]'), null)
  assert.equal(view.queryByRole('button', { name: 'Verify code' }), null)
  assert.ok(view.getByRole('button', { name: 'Verify with passkey' }))
  fireEvent.click(view.getByRole('button', { name: 'Email verification code' }))

  await waitFor(() => {
    assert.deepEqual(
      fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/request')?.body,
      {
        email: 'member@example.com',
        redirectTo: '/account',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    )
  })

  assert.ok(view.getByText('Verification code sent to member@example.com. Enter it below to continue.'))
  await view.findByDisplayValue('ABCD-EFGH')
  assert.ok(document.body.querySelector('input[autocomplete="one-time-code"]'))
  assert.equal(view.queryByRole('button', { name: 'Verify with passkey' }), null)
  assert.ok(view.getByRole('button', { name: 'Resend verification code' }))
  assert.ok(view.getByRole('button', { name: 'Verify code' }))
})

test('CurrentAccountPanel requires verification before adding a passkey and hides code entry until email delivery is chosen', async () => {
  const now = Date.now()
  const bootstrap = buildBootstrap()
  const sessions: AuthSessionListResponse = {
    sessions: [{
      id: 'session-1',
      current: true,
      userAgent: 'Test Browser',
      createdAt: new Date(now - 60 * 60 * 1000).toISOString(),
      lastSeenAt: new Date(now - 5 * 60 * 1000).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    }]
  }
  const profile = buildProfile()

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/auth/sessions':
        return jsonResponse(sessions)
      case 'GET /api/auth/me':
        return jsonResponse(profile)
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse({ passkeys: [] })
      case 'POST /api/plugins/auth-local/passkeys/register/options':
        return jsonResponse({ error: 'Verify your identity again to continue.' }, 403)
      case 'POST /api/plugins/auth-local/email-codes/request':
        return jsonResponse({
          delivered: true,
          expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
          previewCode: 'ABCD-EFGH'
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />)

  await view.findByRole('button', { name: 'Create passkey' })
  fireEvent.click(view.getByRole('button', { name: 'Create passkey' }))
  fireEvent.click(await view.findByRole('button', { name: 'Continue' }))

  await view.findByText('Verify to create a passkey')
  await waitFor(() => {
    assert.equal(
      fetchCalls.some((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/passkeys/register/options'),
      true
    )
  })
  assert.equal(document.body.querySelector('input[autocomplete="one-time-code"]'), null)
  assert.equal(view.queryByRole('button', { name: 'Verify code' }), null)
  assert.equal(view.queryByRole('button', { name: 'Verify with passkey' }), null)

  fireEvent.click(view.getByRole('button', { name: 'Email verification code' }))

  await waitFor(() => {
    assert.deepEqual(
      fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/email-codes/request')?.body,
      {
        email: 'member@example.com',
        redirectTo: '/account',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    )
  })

  assert.ok(document.body.querySelector('input[autocomplete="one-time-code"]'))
  assert.equal(view.queryByRole('button', { name: 'Verify with passkey' }), null)
  assert.ok(view.getByRole('button', { name: 'Resend verification code' }))
  assert.ok(view.getByRole('button', { name: 'Verify code' }))
})

test('CurrentAccountPanel hides auth-local account security controls when auth-local is not enabled', async () => {
  const now = Date.now()

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
      case 'GET /api/auth/sessions':
        return jsonResponse({
          sessions: [{
            id: 'session-1',
            current: true,
            userAgent: 'Test Browser',
            createdAt: new Date(now).toISOString(),
            lastSeenAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
          }]
        })
      case 'GET /api/auth/me':
        return jsonResponse(buildProfile())
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />)

  await view.findByDisplayValue('Member')
  assert.equal(view.queryByText('Local sign-in methods'), null)
  assert.equal(fetchCalls.some((call) => call.pathname === '/api/plugins/auth-local/passkeys'), false)
})

test('CurrentAccountPanel warns tenant-scoped support users and opens the platform account instead', async () => {
  let bootstrapRequests = 0

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap': {
        bootstrapRequests += 1
        if (bootstrapRequests === 1) {
          return jsonResponse({
            ...buildBootstrap(),
            tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
            actor: { ...buildBootstrap().actor, isPlatformUser: true }
          })
        }

        return jsonResponse({
          ...buildBootstrap(),
          actor: { ...buildBootstrap().actor, isPlatformUser: true }
        })
      }
      case 'POST /api/auth/tenant-context':
        return jsonResponse({})
      case 'GET /api/auth/me':
        return jsonResponse(buildProfile())
      case 'GET /api/auth/sessions':
        return jsonResponse({ sessions: [] })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />)

  await view.findByText('Support users manage their own account only from the platform workspace.')
  assert.equal(view.queryByText('Current email'), null)
  assert.equal(fetchCalls.some((call) => call.pathname === '/api/auth/me'), false)
  assert.equal(fetchCalls.some((call) => call.pathname === '/api/auth/sessions'), false)

  fireEvent.click(view.getByRole('button', { name: 'Open platform account' }))

  await waitFor(() => {
    assert.deepEqual(
      fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/auth/tenant-context')?.body,
      { tenantId: null }
    )
  })

  await view.findByDisplayValue('Member')
  assert.equal(bootstrapRequests >= 2, true)
})

test('CurrentAccountPanel shows the account on the platform route while tenant context refreshes', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          actor: { ...buildBootstrap().actor, isPlatformUser: true }
        })
      case 'GET /api/auth/me':
        return jsonResponse(buildProfile())
      case 'GET /api/auth/sessions':
        return jsonResponse({ sessions: [] })
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse({ passkeys: [] })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />, { initialEntries: ['/platform/account'] })

  await view.findByDisplayValue('Member')
  assert.equal(view.queryByRole('button', { name: 'Open platform account' }), null)
  assert.equal(view.queryByText('Support users manage their own account only from the platform workspace.'), null)
})

test('PlatformAuthSummarySection keeps only the notice visible until platform auth is enabled', async () => {
  const view = renderWithProviders(
    <PlatformAuthSummarySection
      authBootstrap={{
        ...buildBootstrap(),
        authEnabled: false,
        setupRequired: true,
        actor: { type: 'anonymous', isPlatformUser: false }
      }}
      authProviders={[{
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
      }]}
    />
  )

  await view.findByText('Platform Authentication controls how platform users access the host workspace. Workspace auth is managed from each workspace settings page.')
  assert.equal(view.queryByText('Enabled providers'), null)
})

test('PlatformAuthSummarySection keeps only the notice visible after platform auth is enabled', async () => {
  const view = renderWithProviders(
    <PlatformAuthSummarySection
      authBootstrap={{
        ...buildBootstrap(),
        authEnabled: true,
        setupRequired: false,
        actor: {
          type: 'user',
          userId: 'user-1',
          email: 'platform@example.com',
          displayName: 'Platform Admin',
          isPlatformUser: true
        }
      }}
      authProviders={[{
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
      }]}
    />
  )

  await view.findByText('Platform Authentication controls how platform users access the host workspace. Workspace auth is managed from each workspace settings page.')
  assert.equal(view.queryByText('Enabled providers'), null)
  assert.equal(view.queryByText('Local auth'), null)
})

test('CurrentAccountPanel verifies a new email address before applying an email change', async () => {
  const now = Date.now()
  const bootstrap = buildBootstrap()
  const sessions: AuthSessionListResponse = {
    sessions: [{
      id: 'session-1',
      current: true,
      userAgent: 'Test Browser',
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60 * 60 * 1000).toISOString()
    }]
  }
  const profile = buildProfile()

  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/auth/sessions':
        return jsonResponse(sessions)
      case 'GET /api/auth/me':
        return jsonResponse(profile)
      case 'GET /api/plugins/auth-local/passkeys':
        return jsonResponse({ passkeys: [] })
      case 'POST /api/plugins/auth-local/me/email-change/request':
        return jsonResponse({
          delivered: true,
          expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
          previewCode: 'ABCD-EFGH'
        })
      case 'POST /api/plugins/auth-local/me/email-change/verify':
        return jsonResponse({
          user: {
            ...profile.user,
            email: 'updated.member@example.com'
          }
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<CurrentAccountPanel showHeading />)

  await view.findByRole('button', { name: 'Change email' })
  const emailInput = view.container.querySelector('input[type="email"]') as HTMLInputElement | null
  assert.ok(emailInput)
  fireEvent.input(emailInput, { target: { value: 'updated.member@example.com' } })
  await waitFor(() => {
    assert.equal(emailInput.value, 'updated.member@example.com')
  })

  fireEvent.click(view.getByRole('button', { name: 'Change email' }))

  await view.findByText('Verify your new email address')

  await waitFor(() => {
    assert.deepEqual(
      fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/me/email-change/request')?.body,
      {
        email: 'updated.member@example.com',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      }
    )
  })

  assert.equal(fetchCalls.some((call) => call.method === 'PATCH' && call.pathname === '/api/auth/me'), false)
  await view.findByDisplayValue('ABCD-EFGH')

  const codeInput = document.body.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement | null
  assert.ok(codeInput)
  fireEvent.input(codeInput, { target: { value: 'ABCD-EFGH' } })
  await waitFor(() => {
    assert.equal(codeInput.value, 'ABCD-EFGH')
  })
  fireEvent.click(view.getByRole('button', { name: 'Verify email' }))

  await waitFor(() => {
    assert.deepEqual(
      fetchCalls.find((call) => call.method === 'POST' && call.pathname === '/api/plugins/auth-local/me/email-change/verify')?.body,
      {
        email: 'updated.member@example.com',
        code: 'ABCD-EFGH',
        displayName: 'Member'
      }
    )
  })

  await waitFor(() => {
    assert.equal((view.container.querySelector('input[type="email"]') as HTMLInputElement | null)?.value, 'updated.member@example.com')
  })
})
