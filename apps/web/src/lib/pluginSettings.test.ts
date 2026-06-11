import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebPlugin } from '../plugin/types.js'
import {
  compareNotificationPluginEntries,
  extractDisabledPluginNameFromErrorMessage,
  extractUnavailablePluginNameFromErrorMessage,
  getPluginDisplayName,
  getNewlyDisabledPluginNames,
  getNewlyDisabledPluginNamesForSnapshot,
  isAuthPlugin,
  isPluginActiveByName,
  isNotificationPlugin,
  mergePlugins,
  shouldRenderPluginSettingsPanel,
  type ApiPluginInfo,
  type MergedPluginEntry
} from './pluginSettings.js'

function createApiPlugin(input: Partial<ApiPluginInfo> & Pick<ApiPluginInfo, 'name'>): ApiPluginInfo {
  return {
    source: 'builtin',
    installed: true,
    enabled: true,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled',
    availableInCurrentContext: true,
    ...input
  }
}

const panelPlugin: WebPlugin = {
  name: 'notifications-browser',
  settingsPanel: () => null
}

test('shouldRenderPluginSettingsPanel hides disabled plugin panels and routes notification panels to the notifications surface', () => {
  const notificationsEntry: MergedPluginEntry = {
    name: 'notifications-browser',
    api: createApiPlugin({
      name: 'notifications-browser',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      tenantAccess: 'none'
    }),
    web: panelPlugin
  }
  const disabledEntry: MergedPluginEntry = {
    ...notificationsEntry,
    api: {
      ...notificationsEntry.api!,
      enabled: false
    }
  }
  const managerEntry: MergedPluginEntry = {
    name: 'plate-clearing',
    api: createApiPlugin({ name: 'plate-clearing' }),
    web: {
      name: 'plate-clearing',
      settingsPanel: () => null
    }
  }
  const authEntry: MergedPluginEntry = {
    name: 'auth-oauth',
    api: createApiPlugin({ name: 'auth-oauth' }),
    web: {
      name: 'auth-oauth',
      settingsPanel: () => null
    }
  }

  assert.equal(shouldRenderPluginSettingsPanel(notificationsEntry, 'notifications'), true)
  assert.equal(shouldRenderPluginSettingsPanel(notificationsEntry, 'manager'), false)
  assert.equal(shouldRenderPluginSettingsPanel(disabledEntry, 'notifications'), false)
  assert.equal(shouldRenderPluginSettingsPanel(managerEntry, 'notifications'), false)
  assert.equal(shouldRenderPluginSettingsPanel(managerEntry, 'manager'), true)
  assert.equal(shouldRenderPluginSettingsPanel(authEntry, 'manager'), false)
})

test('mergePlugins combines api and web metadata and keeps notification channels ordered with browser first', () => {
  const apiPlugins: ApiPluginInfo[] = [
    createApiPlugin({
      name: 'notifications-ntfy',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      tenantAccess: 'none'
    }),
    createApiPlugin({
      name: 'notifications-browser',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      tenantAccess: 'none'
    })
  ]
  const webPlugins: WebPlugin[] = [
    {
      name: 'notifications-browser',
      description: 'Browser push',
      settingsPanel: () => null
    },
    {
      name: 'notifications-discord',
      description: 'Discord',
      settingsPanel: () => null
    }
  ]

  const merged = mergePlugins(apiPlugins, webPlugins)
  assert.equal(isNotificationPlugin('notifications-discord'), true)
  assert.equal(isNotificationPlugin('plate-clearing'), false)
  assert.equal(isAuthPlugin('auth-local'), true)
  assert.equal(isAuthPlugin('orders'), false)
  assert.deepEqual(
    [...merged].filter((entry) => isNotificationPlugin(entry.name)).sort(compareNotificationPluginEntries).map((entry) => entry.name),
    ['notifications-browser', 'notifications-discord', 'notifications-ntfy']
  )
  assert.equal(merged.find((entry) => entry.name === 'notifications-browser')?.description, 'Browser push')
})

test('getPluginDisplayName returns nicer user-facing titles for built-in plugins', () => {
  assert.equal(getPluginDisplayName('notifications-browser'), 'Browser Push Notifications')
  assert.equal(getPluginDisplayName('notifications-discord'), 'Discord Notifications')
  assert.equal(getPluginDisplayName('notifications-ntfy'), 'ntfy Notifications')
  assert.equal(getPluginDisplayName('firmware-updates'), 'Firmware Updates')
  assert.equal(getPluginDisplayName('home-assistant'), 'Home Assistant')
  assert.equal(getPluginDisplayName('plate-clearing'), 'Plate Clearing')
})

test('isPluginActiveByName waits for plugin state and leaves unknown web-only plugins active once loaded', () => {
  const plugins = new Map<string, ApiPluginInfo>([
    ['model-previewer', createApiPlugin({
      name: 'model-previewer',
      enabled: false
    })]
  ])

  assert.equal(isPluginActiveByName('model-previewer', plugins, true), false)
  assert.equal(isPluginActiveByName('web-only-demo', plugins, true), true)
  assert.equal(isPluginActiveByName('model-previewer', plugins, false), false)
  assert.equal(isPluginActiveByName('web-only-demo', plugins, false), false)
})

test('getNewlyDisabledPluginNames only reports fresh enabled-to-disabled transitions', () => {
  const previous: ApiPluginInfo[] = [
    createApiPlugin({
      name: 'firmware-updates',
      enabled: true
    }),
    createApiPlugin({
      name: 'orders',
      enabled: false
    }),
    createApiPlugin({
      name: 'notifications-browser',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      tenantAccess: 'none'
    })
  ]
  const next: ApiPluginInfo[] = [
    createApiPlugin({
      name: 'firmware-updates',
      enabled: false
    }),
    createApiPlugin({
      name: 'orders',
      enabled: false
    }),
    createApiPlugin({
      name: 'notifications-browser',
      installed: false,
      enabled: false,
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      tenantAccess: 'none'
    })
  ]

  assert.deepEqual(getNewlyDisabledPluginNames(previous, next), ['firmware-updates'])
})

test('getNewlyDisabledPluginNamesForSnapshot ignores tenant-scope changes', () => {
  const tenantOnePlugins: ApiPluginInfo[] = [
    createApiPlugin({ name: 'firmware-updates', enabled: true }),
    createApiPlugin({ name: 'orders', enabled: true })
  ]
  const tenantTwoPlugins: ApiPluginInfo[] = [
    createApiPlugin({ name: 'firmware-updates', enabled: false }),
    createApiPlugin({ name: 'orders', enabled: true })
  ]

  assert.deepEqual(
    getNewlyDisabledPluginNamesForSnapshot(
      { scopeKey: 'tenant-1', plugins: tenantOnePlugins },
      { scopeKey: 'tenant-2', plugins: tenantTwoPlugins }
    ),
    []
  )
  assert.deepEqual(
    getNewlyDisabledPluginNamesForSnapshot(
      { scopeKey: 'tenant-2', plugins: tenantOnePlugins },
      { scopeKey: 'tenant-2', plugins: tenantTwoPlugins }
    ),
    ['firmware-updates']
  )
})

test('extractDisabledPluginNameFromErrorMessage parses plugin-disabled api errors', () => {
  assert.equal(extractDisabledPluginNameFromErrorMessage('Plugin disabled: notifications-browser'), 'notifications-browser')
  assert.equal(extractDisabledPluginNameFromErrorMessage('Plugin not installed: notifications-browser'), null)
})

test('extractUnavailablePluginNameFromErrorMessage handles disabled and not-installed plugin errors', () => {
  assert.equal(extractUnavailablePluginNameFromErrorMessage('Plugin disabled: notifications-browser'), 'notifications-browser')
  assert.equal(extractUnavailablePluginNameFromErrorMessage('Plugin not installed: notifications-browser'), 'notifications-browser')
  assert.equal(extractUnavailablePluginNameFromErrorMessage('Authentication required.'), null)
})
