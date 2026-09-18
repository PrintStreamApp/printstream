/**
 * Built-in plugin loader. Imported once from `main.tsx` so plugins are
 * registered (and their init hooks fired) before the React tree mounts.
 */
import { webPluginRegistry } from './registry'
import { modelStudioPlugin } from '../plugins/model-studio'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser'
import { notificationsMobilePlugin } from '../plugins/notifications-mobile'
import { notificationsDesktopPlugin } from '../plugins/notifications-desktop'
import { notificationsEmailWebPlugin } from '../plugins/notifications-email'
import { emailSmtpWebPlugin } from '../plugins/email-smtp'
import { plateClearingPlugin } from '../plugins/plate-clearing'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates'
import { bambuCloudSyncWebPlugin } from '../plugins/bambu-cloud-sync'
import { ordersPlugin } from '../plugins/orders'
import { filamentManagerPlugin } from '../plugins/filament-manager'
import { calibrationPlugin } from '../plugins/calibration'
import { maintenanceWebPlugin } from '../plugins/maintenance'
import { printQueuePlugin } from '../plugins/print-queue'
import { homeAssistantWebPlugin } from '../plugins/home-assistant'
import { authPasswordWebPlugin } from '../plugins/auth-password'
import { authOauthWebPlugin } from '../plugins/auth-oauth'
import { privateWebPlugins } from '../lib/privateModules'
import { remoteImportsPlugin } from '../plugins/remote-imports'
import { cloudConnectionWebPlugin } from '../plugins/cloud-connection'
import type { WebPlugin } from './types'
import type { PluginSurface } from '@printstream/shared'

export function registerBuiltinPlugins(): void {
  // Auth provider web companions. auth-password ships publicly; auth-local is
  // closed-source and contributed cloud-only via the private web module
  // (`privateWebPlugins`, empty in OSS). Each section renders null unless its
  // provider appears in the auth bootstrap, so the API build gate decides what shows.
  registerBuiltinPlugin(authPasswordWebPlugin, { runtimeSurfaces: ['platform', 'workspace'], managerSurfaces: ['platform'] })
  registerBuiltinPlugin(authOauthWebPlugin, { runtimeSurfaces: ['platform', 'workspace'], managerSurfaces: ['platform'] })
  for (const plugin of privateWebPlugins) {
    registerBuiltinPlugin(plugin, {
      runtimeSurfaces: ['platform', 'workspace'],
      managerSurfaces: ['platform'],
      cloudOnly: true
    })
  }
  registerBuiltinPlugin(modelStudioPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsNtfyPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsDiscordPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsBrowserPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsMobilePlugin, { runtimeSurfaces: ['platform', 'workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsDesktopPlugin, { runtimeSurfaces: ['platform', 'workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(notificationsEmailWebPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  // email-smtp is OSS-only: the API registers its backend only when self-hosted, so hide the
  // manager panel in cloud too (the web can only know at runtime via runtimePolicy.selfHosted).
  registerBuiltinPlugin(emailSmtpWebPlugin, { runtimeSurfaces: ['platform', 'workspace'], managerSurfaces: ['platform', 'workspace'], selfHostedOnly: true })
  registerBuiltinPlugin(plateClearingPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(firmwareUpdatesPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(bambuCloudSyncWebPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(ordersPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(filamentManagerPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(calibrationPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(printQueuePlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(homeAssistantWebPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(maintenanceWebPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(remoteImportsPlugin, { runtimeSurfaces: ['workspace'], managerSurfaces: ['platform', 'workspace'] })
  registerBuiltinPlugin(cloudConnectionWebPlugin, {
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    selfHostedOnly: true
  })
  webPluginRegistry.runInitHooks()
}

function registerBuiltinPlugin(
  plugin: WebPlugin,
  metadata: {
    runtimeSurfaces: PluginSurface[]
    managerSurfaces: PluginSurface[]
    selfHostedOnly?: boolean
    cloudOnly?: boolean
  }
): void {
  webPluginRegistry.register({ ...plugin, ...metadata })
}
