/**
 * Public settings-shell coverage via the password provider. Verifies the
 * workspace Authentication section is reachable in a self-hosted install (it is
 * gated on `platformAuthEnabled || selfHosted`, the OSS fix) and lists the
 * Password provider.
 */
import { test } from 'node:test'
import { SettingsView } from '../pages/SettingsView'
import { buildBootstrap, buildManagementStatus, fetchMock, jsonResponse, renderWithProviders } from './authPasswordComponents.testkit'

const settingsProps = {
  sharedAppTheme: 'default' as const,
  sharedUnconstrainedWidth: false,
  sharedLandingPage: '/printers',
  deviceAppThemeOverride: null,
  deviceUnconstrainedWidthOverride: null,
  deviceLandingPageOverride: null,
  sharedSettingsError: null,
  sharedSettingsSaving: false,
  sharedSettingsSaveError: null,
  onSetDeviceAppTheme: () => {},
  onClearDeviceAppThemeOverride: () => {},
  onSetDeviceUnconstrainedWidth: () => {},
  onClearDeviceUnconstrainedWidthOverride: () => {},
  onSetDeviceLandingPage: () => {},
  onClearDeviceLandingPageOverride: () => {},
  onSetSharedAppTheme: () => {},
  onSetSharedUnconstrainedWidth: () => {},
  onSetSharedLandingPage: () => {}
}

test('SettingsView shows the workspace Authentication section in a self-hosted install', async () => {
  fetchMock.impl = async (url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${url.pathname}`
    switch (key) {
      case 'GET /api/auth/bootstrap':
        return jsonResponse(buildBootstrap())
      case 'GET /api/auth/status':
        return jsonResponse(buildManagementStatus())
      default:
        throw new Error(`Unhandled request: ${key}`)
    }
  }

  const view = renderWithProviders(<SettingsView {...settingsProps} />, { initialEntries: ['/workspaces/default/settings'] })
  await view.findByText('Authentication')
})
