import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebPlugin } from '../plugin/types.js'
import type { RegisteredWebPluginSlot } from '../plugin/registry.js'
import { cloudConnectionWebPlugin } from '../plugins/cloud-connection/index.js'
import {
  activePluginSlots,
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
  pluginSlotSupportsActor,
  pluginSupportsDeployment,
  shouldMountPluginRouteByName,
  shouldRenderPluginSettingsPanel,
  type ApiPluginInfo,
  type MergedPluginEntry
} from './pluginSettings.js'

function createApiPlugin(input: Partial<ApiPluginInfo> & Pick<ApiPluginInfo, 'name'>): ApiPluginInfo {
  return {
    source: 'builtin',
    installed: true,
    enabled: true,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled',
    availableInCurrentContext: true,
    ...input
  }
}

const panelPlugin: WebPlugin = {
  name: 'notifications-browser',
  settingsPanel: () => null
}

test('authenticated-user slots stay hidden for anonymous actors', () => {
  const protectedSlot = { requiresAuthenticatedUser: true }
  assert.equal(pluginSlotSupportsActor(protectedSlot, undefined), false)
  assert.equal(pluginSlotSupportsActor(protectedSlot, 'anonymous'), false)
  assert.equal(pluginSlotSupportsActor(protectedSlot, 'service-account'), false)
  assert.equal(pluginSlotSupportsActor(protectedSlot, 'user'), true)
  assert.equal(pluginSlotSupportsActor({}, 'anonymous'), true)
})

test('cloud connection slots remain available to an auth-disabled administrator', () => {
  assert.ok(cloudConnectionWebPlugin.slots?.length)
  assert.equal(
    cloudConnectionWebPlugin.slots?.every((slot) => pluginSlotSupportsActor(slot, 'anonymous')),
    true
  )
})

test('deployment-specific web contributions stay on their intended host', () => {
  assert.equal(pluginSupportsDeployment({ selfHostedOnly: true }, true), true)
  assert.equal(pluginSupportsDeployment({ selfHostedOnly: true }, false), false)
  assert.equal(pluginSupportsDeployment({ cloudOnly: true }, true), false)
  assert.equal(pluginSupportsDeployment({ cloudOnly: true }, false), true)
  assert.equal(pluginSupportsDeployment({}, true), true)
  assert.equal(pluginSupportsDeployment({}, false), true)
})

test('activePluginSlots applies deployment and actor gates without runtime context', () => {
  const slots: RegisteredWebPluginSlot[] = [
    {
      name: 'account.support',
      component: () => null,
      pluginName: 'support',
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform'],
      cloudOnly: true
    },
    {
      name: 'account.support',
      component: () => null,
      pluginName: 'cloud-connection',
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      selfHostedOnly: true
    }
  ]
  const apiPlugins = new Map<string, ApiPluginInfo>([
    ['cloud-connection', createApiPlugin({ name: 'cloud-connection' })]
  ])

  assert.deepEqual(activePluginSlots(slots, {
    selfHosted: true,
    actorType: 'user',
    currentSurface: 'workspace',
    apiPluginsByName: apiPlugins,
    hasPluginState: true
  }).map((slot) => slot.pluginName), ['cloud-connection'])
  assert.deepEqual(activePluginSlots(slots, {
    selfHosted: true,
    actorType: 'anonymous',
    currentSurface: 'workspace',
    apiPluginsByName: apiPlugins,
    hasPluginState: true
  }).map((slot) => slot.pluginName), ['cloud-connection'])
  assert.deepEqual(activePluginSlots(slots, {
    selfHosted: false,
    actorType: 'user',
    currentSurface: 'workspace',
    apiPluginsByName: apiPlugins,
    hasPluginState: true
  }).map((slot) => slot.pluginName), ['support'])
})

// A route must outlive the plugin-state load window that a nav tab deliberately
// waits out, otherwise a cold-loaded deep link 404s before the answer arrives.
test('shouldMountPluginRouteByName keeps plugin deep links mounted until plugin state loads', () => {
  const apiPluginsByName = new Map<string, ApiPluginInfo>()
  assert.equal(shouldMountPluginRouteByName('remote-imports', apiPluginsByName, false), true)
  assert.equal(isPluginActiveByName('remote-imports', apiPluginsByName, false), false)
})

test('shouldMountPluginRouteByName unmounts disabled plugin routes once plugin state is ready', () => {
  const apiPluginsByName = new Map<string, ApiPluginInfo>([
    ['remote-imports', createApiPlugin({ name: 'remote-imports', enabled: false })]
  ])
  assert.equal(shouldMountPluginRouteByName('remote-imports', apiPluginsByName, true), false)
})

test('shouldMountPluginRouteByName mounts active plugin routes once plugin state is ready', () => {
  const apiPluginsByName = new Map<string, ApiPluginInfo>([
    ['remote-imports', createApiPlugin({ name: 'remote-imports' })]
  ])
  assert.equal(shouldMountPluginRouteByName('remote-imports', apiPluginsByName, true), true)
})

test('shouldRenderPluginSettingsPanel hides disabled plugin panels and routes notification panels to the notifications surface', () => {
  const notificationsEntry: MergedPluginEntry = {
    name: 'notifications-browser',
    api: createApiPlugin({
      name: 'notifications-browser',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      workspaceAccess: 'none'
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
      workspaceAccess: 'none'
    }),
    createApiPlugin({
      name: 'notifications-browser',
      runtimeSurfaces: ['platform'],
      managerSurfaces: ['platform'],
      workspaceAccess: 'none'
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
    ['model-studio', createApiPlugin({
      name: 'model-studio',
      enabled: false
    })]
  ])

  assert.equal(isPluginActiveByName('model-studio', plugins, true), false)
  assert.equal(isPluginActiveByName('web-only-demo', plugins, true), true)
  assert.equal(isPluginActiveByName('model-studio', plugins, false), false)
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
      workspaceAccess: 'none'
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
      workspaceAccess: 'none'
    })
  ]

  assert.deepEqual(getNewlyDisabledPluginNames(previous, next), ['firmware-updates'])
})

test('getNewlyDisabledPluginNamesForSnapshot ignores workspace-scope changes', () => {
  const workspaceOnePlugins: ApiPluginInfo[] = [
    createApiPlugin({ name: 'firmware-updates', enabled: true }),
    createApiPlugin({ name: 'orders', enabled: true })
  ]
  const workspaceTwoPlugins: ApiPluginInfo[] = [
    createApiPlugin({ name: 'firmware-updates', enabled: false }),
    createApiPlugin({ name: 'orders', enabled: true })
  ]

  assert.deepEqual(
    getNewlyDisabledPluginNamesForSnapshot(
      { scopeKey: 'workspace-1', plugins: workspaceOnePlugins },
      { scopeKey: 'workspace-2', plugins: workspaceTwoPlugins }
    ),
    []
  )
  assert.deepEqual(
    getNewlyDisabledPluginNamesForSnapshot(
      { scopeKey: 'workspace-2', plugins: workspaceOnePlugins },
      { scopeKey: 'workspace-2', plugins: workspaceTwoPlugins }
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
