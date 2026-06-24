/**
 * Public coverage of the user/role management overview (AuthAccessSection) with
 * the password provider. The auth-local-specific cases (passkeys) live in the
 * cloud-only test; this keeps the provider-agnostic overview covered publicly.
 */
import { test } from 'node:test'
import { AuthAccessSection } from './AuthAccessSection'
import { buildManagementStatus, buildPasswordProvider, fetchMock, jsonResponse, renderWithProviders } from './authPasswordComponents.testkit'

test('AuthAccessSection overview renders the user and role management entries', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'GET /api/settings':
        return jsonResponse({})
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({ counts: { users: 1, groups: 1, serviceAccounts: 0 } })}
      statusLoading={false}
      statusError={null}
      authProviders={[buildPasswordProvider()]}
      authScopeKey="tenant-1"
      canManageSupportAccess
      mode="overview"
      onOpenUsers={() => {}}
      onOpenRoles={() => {}}
    />
  )

  await view.findByRole('button', { name: 'Open users' })
  await view.findByRole('button', { name: 'Open roles' })
})
