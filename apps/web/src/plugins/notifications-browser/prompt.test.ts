import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isBrowserNotificationsPluginEnabled,
  shouldShowBrowserNotificationEnrollmentPrompt,
  type BrowserNotificationEnrollmentPromptState
} from './prompt.js'
import type { ApiPluginInfo } from '../../lib/pluginSettings.js'

function createApiPlugin(input: Partial<ApiPluginInfo> & Pick<ApiPluginInfo, 'name'>): ApiPluginInfo {
  return {
    source: 'builtin',
    installed: true,
    enabled: true,
    runtimeSurfaces: ['platform'],
    managerSurfaces: ['platform'],
    tenantAccess: 'none',
    availableInCurrentContext: true,
    ...input
  }
}

const supportedState: BrowserNotificationEnrollmentPromptState = {
  pluginEnabled: true,
  support: {
    secureContext: true,
    notification: true,
    serviceWorker: true,
    pushManager: true
  },
  permission: 'default',
  subscribed: false,
  dismissed: false
}

test('shouldShowBrowserNotificationEnrollmentPrompt only nudges supported, enabled, unsubscribed devices', () => {
  assert.equal(shouldShowBrowserNotificationEnrollmentPrompt(supportedState), true)
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({ ...supportedState, permission: 'granted' }),
    true
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({ ...supportedState, pluginEnabled: false }),
    false
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({ ...supportedState, subscribed: true }),
    false
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({ ...supportedState, dismissed: true }),
    false
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({ ...supportedState, permission: 'denied' }),
    false
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({
      ...supportedState,
      support: { ...supportedState.support, pushManager: false }
    }),
    false
  )
  assert.equal(
    shouldShowBrowserNotificationEnrollmentPrompt({
      ...supportedState,
      support: { ...supportedState.support, secureContext: false }
    }),
    false
  )
})

test('isBrowserNotificationsPluginEnabled requires the api plugin to be installed and enabled', () => {
  assert.equal(isBrowserNotificationsPluginEnabled([]), false)
  assert.equal(
    isBrowserNotificationsPluginEnabled([
      createApiPlugin({ name: 'notifications-browser' })
    ]),
    true
  )
  assert.equal(
    isBrowserNotificationsPluginEnabled([
      createApiPlugin({ name: 'notifications-browser', enabled: false })
    ]),
    false
  )
  assert.equal(
    isBrowserNotificationsPluginEnabled([
      createApiPlugin({ name: 'notifications-browser', availableInCurrentContext: false })
    ]),
    false
  )
})