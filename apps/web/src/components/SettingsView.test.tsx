/* Auth profile/editor component tests. Shared setup, the recording fetch mock, and the
 * bootstrap/profile factories live in ./authProfileEditors.testkit (split out of the former
 * 2,900-line authProfileEditors.test.tsx). */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fireEvent } from '@testing-library/react'
import React from 'react'
import { PlatformView } from '../pages/PlatformView'
import { SettingsView } from '../pages/SettingsView'
import { buildBootstrap, buildManagementStatus, fetchMock, jsonResponse, renderWithProviders } from './authProfileEditors.testkit'

test('SettingsView hides tenant authentication controls until platform auth is enabled', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          platformAuthEnabled: false,
          setupRequired: false,
          tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          actor: { type: 'anonymous', isPlatformUser: false },
          providers: [{
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
              recentVerificationMethods: ['passkey', 'email-code']
            }
          }]
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <SettingsView
      sharedAppTheme="default"
      sharedUnconstrainedWidth={false}
      sharedLandingPage="/printers"
      deviceAppThemeOverride={null}
      deviceUnconstrainedWidthOverride={null}
      deviceLandingPageOverride={null}
      sharedSettingsError={null}
      sharedSettingsSaving={false}
      sharedSettingsSaveError={null}
      onSetDeviceAppTheme={() => {}}
      onClearDeviceAppThemeOverride={() => {}}
      onSetDeviceUnconstrainedWidth={() => {}}
      onClearDeviceUnconstrainedWidthOverride={() => {}}
      onSetDeviceLandingPage={() => {}}
      onClearDeviceLandingPageOverride={() => {}}
      onSetSharedAppTheme={() => {}}
      onSetSharedUnconstrainedWidth={() => {}}
      onSetSharedLandingPage={() => {}}
    />
  )

  await view.findByText('Settings')
  assert.equal(view.queryByText('Local Auth'), null)
  assert.equal(view.queryByText('Authentication'), null)
})

test('SettingsView renders the general subview route', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          permissions: []
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(
    <SettingsView
      sharedAppTheme="default"
      sharedUnconstrainedWidth={false}
      sharedLandingPage="/printers"
      deviceAppThemeOverride={null}
      deviceUnconstrainedWidthOverride={null}
      deviceLandingPageOverride={null}
      sharedSettingsError={null}
      sharedSettingsSaving={false}
      sharedSettingsSaveError={null}
      onSetDeviceAppTheme={() => {}}
      onClearDeviceAppThemeOverride={() => {}}
      onSetDeviceUnconstrainedWidth={() => {}}
      onClearDeviceUnconstrainedWidthOverride={() => {}}
      onSetDeviceLandingPage={() => {}}
      onClearDeviceLandingPageOverride={() => {}}
      onSetSharedAppTheme={() => {}}
      onSetSharedUnconstrainedWidth={() => {}}
      onSetSharedLandingPage={() => {}}
    />,
    { initialEntries: ['/settings/general'] }
  )

  await view.findByText('Full-width layout')
  assert.equal(view.queryByText('Tenant-scoped diagnostic output for this workspace only.'), null)
})

test('PlatformView falls back to the settings overview when the authentication subview is unavailable', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          authEnabled: false,
          providers: []
        })
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<PlatformView />, { initialEntries: ['/platform/settings/authentication'] })

  await view.findByRole('button', { name: /Plugins/ })
  await view.findByRole('button', { name: /Logs/ })
  assert.equal(view.queryByRole('button', { name: /Authentication/ }), null)
  assert.equal(view.queryByText('Install and enable an auth plugin to configure platform sign-in.'), null)
})

test('SettingsView renders the dedicated roles subview as a permission matrix', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse({
          ...buildBootstrap(),
          tenant: { id: 'tenant-1', slug: 'alpha', name: 'Alpha' },
          permissions: ['auth.access.view', 'auth.manageSupportAccess']
        })
      case 'GET /api/auth/status':
        return jsonResponse(buildManagementStatus({
          sessionDuration: 'day',
          permissionDefinitions: [
            {
              key: 'auth.access.view',
              label: 'View access management',
              description: 'Create roles and users.'
            },
            {
              key: 'auth.users.view',
              label: 'View users',
              description: 'View users and their role assignments.'
            },
            {
              key: 'auth.passkeys.view',
              label: 'View User Passkeys',
              description: 'View registered passkeys for managed users.'
            },
            {
              key: 'auth.passkeys.edit',
              label: 'Edit User Passkeys',
              description: 'Rename passkeys registered to managed users.'
            },
            {
              key: 'auth.roles.view',
              label: 'View roles',
              description: 'Inspect role assignments and permissions.'
            },
            {
              key: 'auth.roles.edit',
              label: 'Edit roles',
              description: 'Change existing role definitions.'
            },
            {
              key: 'auth.serviceAccounts.view',
              label: 'View service accounts',
              description: 'View service accounts and their assigned roles.'
            },
            {
              key: 'settings.manage',
              label: 'Manage settings',
              description: 'Update workspace settings.'
            }
          ],
          counts: {
            users: 2,
            groups: 2,
            serviceAccounts: 0
          }
        }))
      case 'GET /api/auth/groups':
        return jsonResponse({ groups: [
          {
            id: 'group-admin',
            key: 'admin',
            name: 'Admin',
            description: 'Full tenant access',
            permissions: ['auth.access.view', 'auth.users.view', 'auth.passkeys.view', 'auth.passkeys.edit', 'auth.roles.view', 'auth.roles.edit', 'auth.serviceAccounts.view', 'settings.manage'],
            isSystem: true,
            canManage: true,
            isEditable: false,
            isRemovable: false,
            userCount: 1,
            serviceAccountCount: 0
          },
          {
            id: 'group-viewer',
            key: 'viewer',
            name: 'Viewer',
            description: 'Read-only access',
            permissions: ['auth.access.view', 'auth.users.view', 'auth.passkeys.view', 'auth.roles.view', 'auth.serviceAccounts.view', 'settings.manage'],
            isSystem: true,
            canManage: true,
            isEditable: false,
            isRemovable: false,
            userCount: 2,
            serviceAccountCount: 0
          },
          {
            id: 'group-operator',
            key: 'operator',
            name: 'Operator',
            description: 'Day-to-day production access',
            permissions: ['auth.access.view', 'auth.users.view', 'auth.passkeys.view', 'auth.roles.view', 'auth.serviceAccounts.view', 'settings.manage'],
            isSystem: false,
            canManage: true,
            isEditable: true,
            isRemovable: true,
            userCount: 1,
            serviceAccountCount: 0
          }
        ] })
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
    <SettingsView
      sharedAppTheme="default"
      sharedUnconstrainedWidth={false}
      sharedLandingPage="/printers"
      deviceAppThemeOverride={null}
      deviceUnconstrainedWidthOverride={null}
      deviceLandingPageOverride={null}
      sharedSettingsError={null}
      sharedSettingsSaving={false}
      sharedSettingsSaveError={null}
      onSetDeviceAppTheme={() => {}}
      onClearDeviceAppThemeOverride={() => {}}
      onSetDeviceUnconstrainedWidth={() => {}}
      onClearDeviceUnconstrainedWidthOverride={() => {}}
      onSetDeviceLandingPage={() => {}}
      onClearDeviceLandingPageOverride={() => {}}
      onSetSharedAppTheme={() => {}}
      onSetSharedUnconstrainedWidth={() => {}}
      onSetSharedLandingPage={() => {}}
    />,
    { initialEntries: ['/settings/auth/roles'] }
  )

  await view.findByRole('button', { name: 'Authentication' })
  await view.findByRole('columnheader', { name: 'Permission' })
  await view.findByRole('columnheader', { name: /Admin/ })
  await view.findByRole('columnheader', { name: /Viewer/ })
  await view.findByRole('columnheader', { name: /Operator/ })
  await view.findByRole('button', { name: 'About Admin role' })
  await view.findByRole('button', { name: 'About View access management permission' })
  await view.findByRole('button', { name: 'Hide built-in roles' })

  const parentRow = await view.findByRole('rowheader', { name: /View roles/ })
  const childRow = await view.findByRole('rowheader', { name: /Edit roles/ })
  const accessRow = await view.findByRole('rowheader', { name: /View access management/ })
  const serviceAccountsRow = await view.findByRole('rowheader', { name: /View service accounts/ })
  const accessDepth = Number(accessRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  const parentDepth = Number(parentRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  const childDepth = Number(childRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  const serviceAccountsDepth = Number(serviceAccountsRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  assert.equal(parentDepth > accessDepth, true)
  assert.equal(parentDepth >= 0, true)
  assert.equal(childDepth > parentDepth, true)

  const usersRow = await view.findByRole('rowheader', { name: /View users/ })
  const passkeysViewRow = await view.findByRole('rowheader', { name: /View User Passkeys/ })
  const passkeysEditRow = await view.findByRole('rowheader', { name: /Edit User Passkeys/ })
  const usersDepth = Number(usersRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  const passkeysViewDepth = Number(passkeysViewRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  const passkeysEditDepth = Number(passkeysEditRow.querySelector('[data-depth]')?.getAttribute('data-depth') ?? '-1')
  assert.equal(usersDepth > accessDepth, true)
  assert.equal(passkeysViewDepth > usersDepth, true)
  assert.equal(passkeysEditDepth > passkeysViewDepth, true)
  assert.equal(serviceAccountsDepth > accessDepth, true)

  fireEvent.click(view.getByRole('button', { name: 'Collapse Authentication group' }))
  assert.equal(view.queryByRole('rowheader', { name: /View access management/ }), null)
  assert.equal(view.queryByRole('rowheader', { name: /View roles/ }), null)
  await view.findByRole('button', { name: 'Expand Authentication group' })
  fireEvent.click(view.getByRole('button', { name: 'Expand Authentication group' }))
  await view.findByRole('rowheader', { name: /View roles/ })

  const headerCells = view.container.querySelectorAll('thead th')
  assert.match(headerCells[1]?.textContent ?? '', /Admin/)
  assert.match(headerCells[2]?.textContent ?? '', /Viewer/)
  assert.match(headerCells[3]?.textContent ?? '', /Operator/)

  fireEvent.click(view.getByRole('button', { name: 'Hide built-in roles' }))

  assert.equal(view.queryByRole('columnheader', { name: /Admin/ }), null)
  assert.equal(view.queryByRole('columnheader', { name: /Viewer/ }), null)
  await view.findByRole('columnheader', { name: /Operator/ })
  await view.findByRole('button', { name: 'Show built-in roles' })
  await view.findByRole('rowheader', { name: /View access management/ })
  await view.findByRole('button', { name: 'Create role' })
  assert.equal(view.queryByRole('button', { name: 'Open roles' }), null)
})
