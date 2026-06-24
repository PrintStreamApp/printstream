/**
 * Public auth-screen coverage via the open-source password provider (the
 * auth-local-based AuthView test is cloud-only). Verifies the auth shell renders
 * the password sign-in form and gates "Forgot password?" on email availability.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitFor } from '@testing-library/react'
import { AuthView } from '../pages/AuthView'
import { buildBootstrap, fetchMock, jsonResponse, renderWithProviders } from './authPasswordComponents.testkit'

function mockAuth(resetAvailable: boolean) {
  const bootstrap = buildBootstrap({ actor: { type: 'anonymous', isPlatformUser: false } })
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(bootstrap)
      case 'GET /api/plugins/auth-password/password-reset':
        return jsonResponse({ available: resetAvailable })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }
}

test('AuthView renders the password sign-in form', async () => {
  mockAuth(false)
  const view = renderWithProviders(<AuthView />, { initialEntries: ['/auth'] })

  await view.findByRole('button', { name: 'Sign In' })
  assert.ok(view.container.querySelector('input[type="email"]'))
  assert.ok(view.container.querySelector('input[type="password"]'))
  // Reset unavailable (no email transport) -> no forgot-password affordance.
  await waitFor(() => {
    assert.equal(view.queryByRole('button', { name: 'Forgot password?' }), null)
  })
})

test('AuthView shows "Forgot password?" only when email reset is available', async () => {
  mockAuth(true)
  const view = renderWithProviders(<AuthView />, { initialEntries: ['/auth'] })

  await view.findByRole('button', { name: 'Forgot password?' })
})
