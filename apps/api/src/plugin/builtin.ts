/**
 * Built-in plugin loader. Lists the plugins shipped with the core app
 * and registers them at startup. Third-party plugin loading would hook
 * in here in a later iteration.
 */
import { pluginRegistry } from './registry.js'
import { authLocalPlugin } from '../plugins/auth-local/index.js'
import { authOauthPlugin } from '../plugins/auth-oauth/index.js'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy/index.js'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord/index.js'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser/index.js'
import { modelStudioPlugin } from '../plugins/model-studio/index.js'
import { plateClearingPlugin } from '../plugins/plate-clearing/index.js'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates/index.js'
import { ordersPlugin } from '../plugins/orders/index.js'
import { homeAssistantPlugin } from '../plugins/home-assistant/index.js'

export async function registerBuiltinPlugins(): Promise<void> {
  await pluginRegistry.register(authLocalPlugin, {
    forceInstalled: true,
    forceEnabled: true,
    runtimeSurfaces: ['platform', 'tenant'],
    managerSurfaces: ['platform'],
    tenantAccess: 'always'
  })
  await pluginRegistry.register(authOauthPlugin, {
    forceInstalled: true,
    forceEnabled: true,
    runtimeSurfaces: ['platform', 'tenant'],
    managerSurfaces: ['platform'],
    tenantAccess: 'always'
  })
  await pluginRegistry.register(modelStudioPlugin, {
    defaultEnabled: true,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsNtfyPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsDiscordPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsBrowserPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(plateClearingPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(firmwareUpdatesPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(ordersPlugin, {
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(homeAssistantPlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
}
