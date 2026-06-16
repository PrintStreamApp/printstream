/* Auth profile/editor component tests. Shared setup, the recording fetch mock, and the
 * bootstrap/profile factories live in ./authProfileEditors.testkit (split out of the former
 * 2,900-line authProfileEditors.test.tsx). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuthManagementStatus } from '@printstream/shared'
import React from 'react'
import { AuthAccessSection, AuthUserManagementDialog, shouldAutoOpenCreatedUserEditor } from './AuthAccessSection'
import { buildBootstrap, buildManagementStatus, fetchCalls, fetchMock, jsonResponse, parseRequestBody, renderWithProviders } from './authProfileEditors.testkit'

test('AuthAccessSection overview mode shows dedicated auth management entry points', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [{
          id: 'group-admin',
          key: 'admin',
          name: 'Admin',
          description: 'Full tenant access',
          permissions: ['auth.access.view'],
          isSystem: true,
          canManage: true,
          isEditable: false,
          isRemovable: false,
          userCount: 1,
          serviceAccountCount: 0
        }] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [{
          id: 'user-1',
          email: 'admin@example.com',
          displayName: 'Primary Admin',
          loginDisabled: false,
          isPlatformUser: false,
          groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
          passkeyCount: 1,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        }] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: ['auth.access.view']
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [{
          key: 'auth.access.view',
          label: 'View access management',
          description: 'Create roles and users.'
        }],
        counts: {
          users: 1,
          groups: 1,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      authScopeKey="tenant-1"
      canManageSupportAccess
      mode="overview"
      onOpenUsers={() => {}}
      onOpenRoles={() => {}}
    />
  )

  const sessionSection = view.container.querySelector('#session-security') as HTMLElement | null
  assert.ok(sessionSection)
  await within(sessionSection).findByText('Auth health')
  await within(sessionSection).findByText('Access management')
  await within(sessionSection).findByRole('button', { name: 'Open users' })
  await within(sessionSection).findByRole('button', { name: 'Open roles' })
  assert.equal(view.queryByRole('button', { name: 'Manage user' }), null)
  assert.equal(view.queryByRole('button', { name: 'Edit role' }), null)
})

test('AuthAccessSection users mode renders user filtering and sorting controls', async () => {
  const user = userEvent.setup({ document: window.document })
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [
          {
            id: 'group-admin',
            key: 'admin',
            name: 'Admin',
            description: 'Full tenant access',
            permissions: ['auth.access.view'],
            isSystem: true,
            canManage: true,
            isEditable: false,
            isRemovable: false,
            userCount: 2,
            serviceAccountCount: 0
          },
          {
            id: 'group-viewer',
            key: 'viewer',
            name: 'Viewer',
            description: 'Read-only access',
            permissions: [],
            isSystem: true,
            canManage: true,
            isEditable: false,
            isRemovable: false,
            userCount: 1,
            serviceAccountCount: 0
          }
        ] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [
          {
            id: 'user-alpha',
            email: 'alpha@example.com',
            displayName: 'Alpha Admin',
            loginDisabled: false,
            isPlatformUser: false,
            groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
            passkeyCount: 1,
            createdAt: '2026-05-02T00:00:00.000Z',
            updatedAt: '2026-05-02T00:00:00.000Z'
          },
          {
            id: 'user-mila',
            email: 'mila@example.com',
            displayName: 'Mila Member',
            loginDisabled: false,
            isPlatformUser: false,
            groups: [{ id: 'group-viewer', key: 'viewer', name: 'Viewer' }],
            passkeyCount: 2,
            createdAt: '2026-05-04T00:00:00.000Z',
            updatedAt: '2026-05-04T00:00:00.000Z'
          },
          {
            id: 'user-zed',
            email: 'zed@example.com',
            displayName: 'Zed Disabled',
            loginDisabled: true,
            isPlatformUser: false,
            groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
            passkeyCount: 0,
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z'
          }
        ] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [{
          key: 'auth.access.view',
          label: 'View access management',
          description: 'Create roles and users.'
        }],
        counts: {
          users: 3,
          groups: 2,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      mode="users"
    />
  )

  await view.findByRole('textbox', { name: 'Filter users' })
  const userToolbarControls = await view.findAllByRole('combobox')
  assert.equal(userToolbarControls.length, 2)
  await view.findAllByText('Showing 1-3 of 3')
  await view.findByRole('button', { name: 'Manage Alpha Admin' })
  await user.click(await view.findByRole('button', { name: 'Filters' }))
  const filtersDialog = await view.findByRole('dialog', { name: 'User filters' })
  assert.equal(within(filtersDialog).getAllByRole('combobox').length, 2)
  assert.equal(view.queryByRole('button', { name: 'Manage user' }), null)
})

test('shouldAutoOpenCreatedUserEditor stays closed for higher-access users', () => {
  assert.equal(shouldAutoOpenCreatedUserEditor([
    {
      id: 'user-new-admin',
      email: 'new-admin@example.com',
      displayName: 'New Admin',
      loginDisabled: false,
      isPlatformUser: false,
      canManage: false,
      groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
      passkeyCount: 0,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z'
    }
  ], 'user-new-admin'), false)

  assert.equal(shouldAutoOpenCreatedUserEditor([
    {
      id: 'user-manageable',
      email: 'manageable@example.com',
      displayName: 'Manageable User',
      loginDisabled: false,
      isPlatformUser: false,
      canManage: true,
      groups: [],
      passkeyCount: 0,
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z'
    }
  ], 'user-manageable'), true)
})

test('AuthUserManagementDialog does not expose global profile editing for managed users', async () => {
  const view = renderWithProviders(
    <AuthUserManagementDialog
      user={{
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 1,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }}
      authProviders={[]}
      canDisableUserSignIn
      canDeleteUsers
      canAssignUserRoles
      canViewRoles
      canViewUserSessions
      canRevokeUserSessions
      canSendUserInvites
      canViewUserPasskeys
      canEditUserPasskeys
      canRevokeUserPasskeys
      groups={[{
        id: 'group-admin',
        key: 'admin',
        name: 'Admin',
        description: 'Full access',
        permissions: [],
        isSystem: true,
        canManage: true,
        isEditable: false,
        isRemovable: false,
        userCount: 1,
        serviceAccountCount: 0,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }]}
      isOnlyEnabledAdmin={false}
      sessions={[]}
      sessionsLoading={false}
      sessionsError={null}
      accessError={null}
      lifecycleError={null}
      deleteError={null}
      savingAccess={false}
      mutatingLifecycle={false}
      revokingSessionId={null}
      onClose={() => {}}
      onSubmit={() => {}}
      onToggleLoginDisabled={() => {}}
      onRevokeSession={() => {}}
      onDeleteRequest={() => {}}
    />
  )

  await view.findByText('Account lifecycle')
  assert.equal(view.queryByRole('textbox', { name: 'Email' }), null)
  assert.equal(view.queryByRole('textbox', { name: 'Display name' }), null)
  assert.equal(view.queryByRole('button', { name: 'Save profile' }), null)
})

test('AuthUserManagementDialog shows built-in roles before custom roles in assignments', async () => {
  const view = renderWithProviders(
    <AuthUserManagementDialog
      user={{
        id: 'user-1',
        email: 'admin@example.com',
        displayName: 'Primary Admin',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 1,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }}
      authProviders={[]}
      canDisableUserSignIn
      canDeleteUsers
      canAssignUserRoles
      canViewRoles
      canViewUserSessions
      canRevokeUserSessions
      canSendUserInvites
      canViewUserPasskeys
      canEditUserPasskeys
      canRevokeUserPasskeys
      groups={[
        {
          id: 'group-test',
          key: 'test',
          name: 'Test',
          description: null,
          permissions: [],
          isSystem: false,
          canManage: true,
          isEditable: true,
          isRemovable: true,
          userCount: 0,
          serviceAccountCount: 0,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        },
        {
          id: 'group-operator',
          key: 'operator',
          name: 'Operator',
          description: 'Run jobs',
          permissions: [],
          isSystem: true,
          canManage: true,
          isEditable: false,
          isRemovable: false,
          userCount: 0,
          serviceAccountCount: 0,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        },
        {
          id: 'group-technician',
          key: 'technician',
          name: 'Manager',
          description: 'Manage operations',
          permissions: [],
          isSystem: true,
          canManage: true,
          isEditable: false,
          isRemovable: false,
          userCount: 0,
          serviceAccountCount: 0,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        },
        {
          id: 'group-viewer',
          key: 'viewer',
          name: 'Viewer',
          description: 'Read-only access',
          permissions: [],
          isSystem: true,
          canManage: true,
          isEditable: false,
          isRemovable: false,
          userCount: 0,
          serviceAccountCount: 0,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        },
        {
          id: 'group-admin',
          key: 'admin',
          name: 'Admin',
          description: 'Full access',
          permissions: [],
          isSystem: true,
          canManage: true,
          isEditable: false,
          isRemovable: false,
          userCount: 1,
          serviceAccountCount: 0,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        }
      ]}
      isOnlyEnabledAdmin={false}
      sessions={[]}
      sessionsLoading={false}
      sessionsError={null}
      accessError={null}
      lifecycleError={null}
      deleteError={null}
      savingAccess={false}
      mutatingLifecycle={false}
      revokingSessionId={null}
      onClose={() => {}}
      onSubmit={() => {}}
      onToggleLoginDisabled={() => {}}
      onRevokeSession={() => {}}
      onDeleteRequest={() => {}}
    />
  )

  await view.findByText('Role assignments')

  const roleLabels = Array.from(
    view.baseElement.querySelectorAll('label .MuiTypography-title-sm')
  ).map((node) => node.textContent)

  assert.deepEqual(roleLabels.slice(0, 5), ['Admin', 'Manager', 'Operator', 'Viewer', 'Test'])
})

test('AuthUserManagementDialog renders managed user passkeys from the local auth plugin', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/plugins/auth-local/users/user-1/passkeys':
        return jsonResponse({
          passkeys: [
            {
              id: 'passkey-1',
              nickname: 'Rachel Passkey',
              aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
              transports: ['hybrid', 'internal'],
              backedUp: true,
              lastUsedAt: null,
              createdAt: '2026-05-11T02:12:53.622Z',
              updatedAt: '2026-05-11T02:12:53.622Z'
            },
            {
              id: 'passkey-2',
              nickname: null,
              aaguid: '9ddd1817-af5a-4672-a2b9-3e3dd95000a9',
              transports: ['internal'],
              backedUp: false,
              lastUsedAt: null,
              createdAt: '2026-05-09T20:16:36.921Z',
              updatedAt: '2026-05-09T20:16:36.921Z'
            }
          ]
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthUserManagementDialog
      user={{
        id: 'user-1',
        email: 'rachel@example.com',
        displayName: 'Rachel Ewen',
        loginDisabled: false,
        isPlatformUser: false,
        groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
        passkeyCount: 2,
        createdAt: '2026-05-09T19:30:44.875Z',
        updatedAt: '2026-05-09T19:33:56.756Z'
      }}
      authProviders={buildBootstrap().providers}
      canDisableUserSignIn
      canDeleteUsers
      canAssignUserRoles
      canViewRoles
      canViewUserSessions
      canRevokeUserSessions
      canSendUserInvites
      canViewUserPasskeys
      canEditUserPasskeys
      canRevokeUserPasskeys
      groups={[{
        id: 'group-admin',
        key: 'admin',
        name: 'Admin',
        description: 'Full access',
        permissions: [],
        isSystem: true,
        canManage: true,
        isEditable: false,
        isRemovable: false,
        userCount: 1,
        serviceAccountCount: 0,
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:00.000Z'
      }]}
      isOnlyEnabledAdmin={false}
      sessions={[]}
      sessionsLoading={false}
      sessionsError={null}
      accessError={null}
      lifecycleError={null}
      deleteError={null}
      savingAccess={false}
      mutatingLifecycle={false}
      revokingSessionId={null}
      onClose={() => {}}
      onSubmit={() => {}}
      onToggleLoginDisabled={() => {}}
      onRevokeSession={() => {}}
      onDeleteRequest={() => {}}
    />
  )

  await view.findByText('Manage user — Rachel Ewen')
  await waitFor(() => {
    assert.equal(
      fetchCalls.some((call) => call.method === 'GET' && call.pathname === '/api/plugins/auth-local/users/user-1/passkeys'),
      true
    )
  })
  await view.findByText('Account lifecycle')

  const passkeysHeading = await view.findByText('Passkeys')
  const sessionsHeading = await view.findByText('Sessions')

  assert.equal(
    Boolean(passkeysHeading.compareDocumentPosition(sessionsHeading) & Node.DOCUMENT_POSITION_FOLLOWING),
    true
  )
})

test('AuthAccessSection hides session and management blocks when no auth provider is enabled', async () => {
  const status: AuthManagementStatus = buildManagementStatus({
    sessionDuration: 'day',
    permissionDefinitions: [],
    counts: {
      users: 0,
      groups: 0,
      serviceAccounts: 0
    }
  })

  const view = renderWithProviders(
    <AuthAccessSection
      status={status}
      statusLoading={false}
      statusError={null}
      authProviders={[{
        id: 'auth-local',
        label: 'Local auth',
        enabled: false,
        methods: ['passkey', 'email-code'],
        setupRequired: false,
        capabilities: {
          signIn: true,
          setup: true,
          accountSecurity: true,
          adminUserProvisioning: true,
          adminUserCredentials: true,
          recentVerificationMethods: []
        }
      }]}
    />
  )

  assert.equal(view.queryByText('Session security'), null)
  assert.equal(view.queryByText('Auth health'), null)
  assert.equal(view.queryByText('Users'), null)
  assert.equal(view.queryByText('Access control'), null)
  assert.equal(view.queryByText('Service accounts'), null)
  assert.equal(view.container.querySelector('input[type="number"]'), null)
  assert.equal(view.queryByRole('button', { name: 'Apply custom' }), null)
})

test('AuthAccessSection only exposes custom session controls for custom policies', async () => {
  const customStatus: AuthManagementStatus = buildManagementStatus({
    sessionDuration: 'custom:45',
    permissionDefinitions: [],
    counts: {
      users: 0,
      groups: 0,
      serviceAccounts: 0
    }
  })

  const presetView = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
    />
  )

  await presetView.findByText('Idle timeout: 1 day')
  assert.equal(presetView.container.querySelector('input[type="number"]'), null)
  assert.equal(presetView.queryByRole('button', { name: 'Apply custom' }), null)

  presetView.unmount()

  const customView = renderWithProviders(
    <AuthAccessSection
      status={customStatus}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
    />
  )

  await customView.findByText('Idle timeout: 45 minutes')
  const customDurationInput = customView.container.querySelector('input[type="number"]') as HTMLInputElement | null
  assert.ok(customDurationInput)
  assert.equal(customDurationInput.min, '15')
  assert.equal(customDurationInput.value, '45')
  await customView.findByRole('button', { name: 'Apply custom' })
})

test('AuthAccessSection opens the shared verification dialog when support access changes need a fresh session', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: []
        })
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [{
          id: 'user-1',
          email: 'admin@example.com',
          displayName: 'Primary Admin',
          loginDisabled: false,
          isPlatformUser: false,
          groups: [{ id: 'group-admin', key: 'admin', name: 'Admin' }],
          passkeyCount: 1,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z'
        }] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'PUT /api/settings':
        return jsonResponse({ error: 'Verify your identity again to continue.' }, 403)
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
      authScopeKey="tenant-1"
      actorEmail="member@example.com"
      canManageSupportAccess
    />
  )

  await view.findByRole('button', { name: 'Disable support access' })
  fireEvent.click(view.getByRole('button', { name: 'Disable support access' }))

  await view.findByText('Verify to change support access')
  assert.ok(view.getByRole('button', { name: 'Email verification code' }))
})

test('AuthAccessSection disables support access changes when tenant auth has no enabled admin users', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: []
        })
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
      authScopeKey="tenant-1"
      actorEmail="member@example.com"
      canManageSupportAccess
    />
  )

  await view.findByRole('button', { name: 'Disable support access' })
  await view.findByText('Create or re-enable an Admin user before disabling support access.')
  const disableSupportAccessButton = view.getByRole('button', { name: 'Disable support access' })
  fireEvent.click(disableSupportAccessButton)
  assert.equal(fetchCalls.some((call) => call.method === 'PUT' && call.pathname === '/api/settings'), false)
})

test('AuthAccessSection auto-grants same-section parent permissions when creating a role', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: []
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        permissionDefinitions: [
          {
            key: 'auth.access.view',
            label: 'View access management',
            description: 'Open roles and users.'
          },
          {
            key: 'auth.users.view',
            label: 'View users',
            description: 'View users and their role assignments.'
          },
          {
            key: 'auth.users.edit',
            label: 'Edit users',
            description: 'Send setup and recovery actions for managed users.'
          }
        ],
        assignablePermissions: ['auth.access.view', 'auth.users.view', 'auth.users.edit'],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      authScopeKey="tenant-1"
    />
  )

  await view.findByRole('button', { name: 'Create role' })
  fireEvent.click(view.getByRole('button', { name: 'Create role' }))

  const dialog = await view.findByRole('dialog', { name: 'Create role' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Collapse Authentication permissions' }))
  assert.equal(within(dialog).queryByRole('checkbox', { name: /Edit users/ }), null)
  await within(dialog).findByRole('button', { name: 'Expand Authentication permissions' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Expand Authentication permissions' }))
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Role name' }), { target: { value: 'Editors' } })
  const editUsers = within(dialog).getByRole('checkbox', { name: /Edit users/ }) as HTMLInputElement
  const viewUsers = within(dialog).getByRole('checkbox', { name: /View users/ }) as HTMLInputElement
  fireEvent.click(editUsers)

  assert.equal(view.queryByText('This selection also requires permissions in other sections.'), null)
  assert.equal(editUsers.checked, true)
  assert.equal(viewUsers.checked, true)
})

test('AuthAccessSection confirms cross-section support access prerequisites in a popover', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: []
        })
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'PUT /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: (parseRequestBody(init.body) as { supportAccessPermissions: string[] }).supportAccessPermissions
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [
          {
            key: 'printers.view',
            label: 'View printers',
            description: 'View printer status, health, and current activity.'
          },
          {
            key: 'prints.dispatch',
            label: 'Dispatch prints',
            description: 'Start prints from library files or printer-hosted files.'
          },
          {
            key: 'library.view',
            label: 'View library',
            description: 'Browse library metadata, listings, and non-raw file details.'
          }
        ],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      authScopeKey="tenant-1"
      canManageSupportAccess
    />
  )

  await view.findByRole('button', { name: 'Edit allowed actions' })
  fireEvent.click(view.getByRole('button', { name: 'Edit allowed actions' }))

  const dialog = await view.findByRole('dialog', { name: 'Allowed support actions' })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /Dispatch prints/ }))

  await view.findByText('This selection also requires permissions in other sections.')
  fireEvent.click(view.getByRole('button', { name: 'Grant all' }))

  await waitFor(() => {
    assert.equal(view.queryByText('This selection also requires permissions in other sections.'), null)
  })

  fireEvent.click(view.getByRole('button', { name: 'Save actions' }))

  await waitFor(() => {
    const saveCall = fetchCalls.find((call) => call.method === 'PUT' && call.pathname === '/api/settings')
    const permissions = ((saveCall?.body as { supportAccessPermissions?: string[] } | undefined)?.supportAccessPermissions ?? []).slice().sort()
    assert.deepEqual(permissions, ['library.view', 'printers.view', 'prints.dispatch'])
  })
})

test('AuthAccessSection confirms dependent removals in a popover', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: []
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        permissionDefinitions: [
          {
            key: 'auth.access.view',
            label: 'View access management',
            description: 'Open roles and users.'
          },
          {
            key: 'auth.users.view',
            label: 'View users',
            description: 'View users and their role assignments.'
          },
          {
            key: 'auth.users.edit',
            label: 'Edit users',
            description: 'Send setup and recovery actions for managed users.'
          }
        ],
        assignablePermissions: ['auth.access.view', 'auth.users.view', 'auth.users.edit'],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      authScopeKey="tenant-1"
    />
  )

  await view.findByRole('button', { name: 'Create role' })
  fireEvent.click(view.getByRole('button', { name: 'Create role' }))

  const dialog = await view.findByRole('dialog', { name: 'Create role' })
  const editUsers = within(dialog).getByRole('checkbox', { name: /Edit users/ }) as HTMLInputElement
  const viewUsers = within(dialog).getByRole('checkbox', { name: /View users/ }) as HTMLInputElement

  fireEvent.click(editUsers)
  assert.equal(editUsers.checked, true)
  assert.equal(viewUsers.checked, true)

  fireEvent.click(viewUsers)
  await view.findByText('Removing this permission also removes dependent permissions that no longer have their required parents.')
  fireEvent.click(view.getByRole('button', { name: 'Remove all' }))

  await waitFor(() => {
    assert.equal(editUsers.checked, false)
    assert.equal(viewUsers.checked, false)
  })
})

test('AuthAccessSection edits support access actions in a dialog', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: ['auth.access.view']
        })
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [] })
      case 'GET /api/auth/users':
        return jsonResponse({ users: [] })
      case 'GET /api/auth/service-accounts':
        return jsonResponse({ serviceAccounts: [] })
      case 'PUT /api/settings':
        return jsonResponse({
          unconstrainedWidth: false,
          supportAccessEnabled: true,
          supportAccessPermissions: (parseRequestBody(init.body) as { supportAccessPermissions: string[] }).supportAccessPermissions
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <AuthAccessSection
      status={buildManagementStatus({
        sessionDuration: 'day',
        permissionDefinitions: [
          {
            key: 'auth.access.view',
            label: 'View access management',
            description: 'Open roles and users.'
          },
          {
            key: 'settings.manage',
            label: 'Manage settings',
            description: 'Update workspace settings.'
          }
        ],
        counts: {
          users: 0,
          groups: 0,
          serviceAccounts: 0
        }
      })}
      statusLoading={false}
      statusError={null}
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
          recentVerificationMethods: []
        }
      }]}
      authScopeKey="tenant-1"
      canManageSupportAccess
    />
  )

  await view.findByRole('button', { name: 'Edit allowed actions' })
  fireEvent.click(view.getByRole('button', { name: 'Edit allowed actions' }))

  const dialog = await view.findByRole('dialog', { name: 'Allowed support actions' })
  await within(dialog).findByText('Authentication')
  fireEvent.click(within(dialog).getByRole('checkbox', { name: /Manage settings/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save actions' }))

  await waitFor(() => {
    const saveCall = fetchCalls.find((call) => call.method === 'PUT' && call.pathname === '/api/settings')
    assert.deepEqual(saveCall?.body, {
      supportAccessPermissions: ['auth.access.view', 'settings.manage']
    })
  })
  await waitFor(() => {
    assert.equal(view.queryByRole('dialog', { name: 'Allowed support actions' }), null)
  })
})
