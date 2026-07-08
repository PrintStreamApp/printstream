/**
 * Built-in plugin loader. Imported once from `main.tsx` so plugins are
 * registered (and their init hooks fired) before the React tree mounts.
 */
import { webPluginRegistry } from './registry'
import { modelStudioPlugin } from '../plugins/model-studio'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser'
import { notificationsEmailWebPlugin } from '../plugins/notifications-email'
import { emailSmtpWebPlugin } from '../plugins/email-smtp'
import { plateClearingPlugin } from '../plugins/plate-clearing'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates'
import { ordersPlugin } from '../plugins/orders'
import { filamentManagerPlugin } from '../plugins/filament-manager'
import { calibrationPlugin } from '../plugins/calibration'
import { printQueuePlugin } from '../plugins/print-queue'
import { homeAssistantWebPlugin } from '../plugins/home-assistant'
import { authPasswordWebPlugin } from '../plugins/auth-password'
import { authOauthWebPlugin } from '../plugins/auth-oauth'
import { privateWebPlugins } from '../lib/privateModules'
import type { WebPlugin } from './types'
import type { PluginSurface } from '@printstream/shared'

export function registerBuiltinPlugins(): void {
  // Auth provider web companions. auth-password ships publicly; auth-local is
  // closed-source and contributed cloud-only via the private web module
  // (`privateWebPlugins`, empty in OSS). Each section renders null unless its
  // provider appears in the auth bootstrap, so the API build gate decides what shows.
  registerBuiltinPlugin(authPasswordWebPlugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform'] })
  registerBuiltinPlugin(authOauthWebPlugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform'] })
  for (const plugin of privateWebPlugins) {
    registerBuiltinPlugin(plugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform'] })
  }
  registerBuiltinPlugin(modelStudioPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsNtfyPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsDiscordPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsBrowserPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(notificationsEmailWebPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  // email-smtp is OSS-only: the API registers its backend only when self-hosted, so hide the
  // manager panel in cloud too (the web can only know at runtime via runtimePolicy.selfHosted).
  registerBuiltinPlugin(emailSmtpWebPlugin, { runtimeSurfaces: ['platform', 'tenant'], managerSurfaces: ['platform', 'tenant'], selfHostedOnly: true })
  registerBuiltinPlugin(plateClearingPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(firmwareUpdatesPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(ordersPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(filamentManagerPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(calibrationPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(printQueuePlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  registerBuiltinPlugin(homeAssistantWebPlugin, { runtimeSurfaces: ['tenant'], managerSurfaces: ['platform', 'tenant'] })
  webPluginRegistry.runInitHooks()
}

function registerBuiltinPlugin(
  plugin: WebPlugin,
  metadata: { runtimeSurfaces: PluginSurface[]; managerSurfaces: PluginSurface[]; selfHostedOnly?: boolean }
): void {
  webPluginRegistry.register({ ...plugin, ...metadata })
}
