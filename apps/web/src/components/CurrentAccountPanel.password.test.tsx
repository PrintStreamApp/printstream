/**
 * Public account-panel coverage via the password provider: a signed-in user can
 * sign out, and the self-service change-password section (auth-password's
 * account.security slot) renders.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CurrentAccountPanel } from './CurrentAccountPanel'
import { buildBootstrap, buildProfile, fetchMock, jsonResponse, renderWithProviders } from './authPasswordComponents.testkit'

function mockAccount() {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(buildBootstrap())
      case 'GET /api/auth/me':
        return jsonResponse(buildProfile())
      case 'GET /api/auth/sessions':
        return jsonResponse({ sessions: [] })
      case 'GET /api/plugins/auth-password/me/password':
        return jsonResponse({ hasPassword: true, mustChangePassword: false, lastChangedAt: null })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }
}

test('CurrentAccountPanel offers sign-out for a signed-in user', async () => {
  mockAccount()
  const view = renderWithProviders(<CurrentAccountPanel showHeading />)
  await view.findByRole('button', { name: 'Sign out' })
})

test('CurrentAccountPanel renders the password change section', async () => {
  mockAccount()
  const view = renderWithProviders(<CurrentAccountPanel showHeading />)
  await view.findByRole('button', { name: 'Change password' })
  assert.ok(view.container.querySelector('input[autocomplete="current-password"]'))
  assert.ok(view.container.querySelector('input[autocomplete="new-password"]'))
})
