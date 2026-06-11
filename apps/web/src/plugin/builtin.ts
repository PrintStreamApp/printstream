/**
 * Built-in plugin loader. Imported once from `main.tsx` so plugins are
 * registered (and their init hooks fired) before the React tree mounts.
 */
import { webPluginRegistry } from './registry'
import { modelPreviewerPlugin } from '../plugins/model-previewer'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser'
import { plateClearingPlugin } from '../plugins/plate-clearing'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates'
import { ordersPlugin } from '../plugins/orders'
import { homeAssistantWebPlugin } from '../plugins/home-assistant'
import { authLocalWebPlugin } from '../plugins/auth-local'
import { authOauthWebPlugin } from '../plugins/auth-oauth'
import type { WebPlugin } from './types'
import type { PluginSurface } from '@printstream/shared'

export function registerBuiltinPlugins(): void {
  registerBuiltinPlugin(authLocalWebPlugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform'] })
  registerBuiltinPlugin(authOauthWebPlugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform'] })
  registerBuiltinPlugin(modelPreviewerPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsNtfyPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsDiscordPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsBrowserPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(plateClearingPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(firmwareUpdatesPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(ordersPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(homeAssistantWebPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  webPluginRegistry.runInitHooks()
}

function registerBuiltinPlugin(
  plugin: WebPlugin,
  metadata: { runtimeSurfaces: PluginSurface[]; managerSurfaces: PluginSurface[] }
): void {
  webPluginRegistry.register({ ...plugin, ...metadata })
}
