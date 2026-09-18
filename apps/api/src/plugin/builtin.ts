/**
 * Built-in plugin loader. Lists the plugins shipped with the core app and
 * registers them at startup with their install/enable defaults and surfaces.
 *
 * This file only wires the FIRST-PARTY built-ins. Third-party plugins are a
 * separate path: they are uploaded as `.zip` archives, extracted into
 * `PLUGINS_DIR`, and re-loaded on each boot by `loadInstalledExternalPlugins`
 * (`plugin/installer.ts`, invoked from `src/index.ts`), not registered here.
 */
import { pluginRegistry } from './registry.js'
import { isSelfHostedDeployment } from '../lib/deployment-mode.js'
import { authPasswordPlugin } from '../plugins/auth-password/index.js'
import { authOauthPlugin } from '../plugins/auth-oauth/index.js'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy/index.js'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord/index.js'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser/index.js'
import { notificationsMobilePlugin } from '../plugins/notifications-mobile/index.js'
import { notificationsDesktopPlugin } from '../plugins/notifications-desktop/index.js'
import { notificationsEmailPlugin } from '../plugins/notifications-email/index.js'
import { emailSmtpPlugin } from '../plugins/email-smtp/index.js'
import { modelStudioPlugin } from '../plugins/model-studio/index.js'
import { plateClearingPlugin } from '../plugins/plate-clearing/index.js'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates/index.js'
import { bambuCloudSyncPlugin } from '../plugins/bambu-cloud-sync/index.js'
import { ordersPlugin } from '../plugins/orders/index.js'
import { filamentManagerPlugin } from '../plugins/filament-manager/index.js'
import { calibrationPlugin } from '../plugins/calibration/index.js'
import { maintenancePlugin } from '../plugins/maintenance/index.js'
import { printQueuePlugin } from '../plugins/print-queue/index.js'
import { homeAssistantPlugin } from '../plugins/home-assistant/index.js'
import { remoteImportsPlugin } from '../plugins/remote-imports/index.js'
import { cloudConnectionPlugin } from '../plugins/cloud-connection/index.js'

export async function registerBuiltinPlugins(): Promise<void> {
  // Build-exclusive auth providers. The self-hosted (OSS) build uses only
  // email/password (`auth-password`). The cloud build uses OIDC single sign-on
  // (`auth-oauth`, here) plus the closed-source passkey/email-code provider
  // (`auth-local`), which is registered by the private cloud module and is not
  // shipped in the public snapshot. An unregistered provider mounts no routes.
  if (isSelfHostedDeployment()) {
    await pluginRegistry.register(authPasswordPlugin, {
      forceInstalled: true,
      forceEnabled: true,
      runtimeSurfaces: ['platform', 'workspace'],
      managerSurfaces: ['platform'],
      workspaceAccess: 'always'
    })
  } else {
    await pluginRegistry.register(authOauthPlugin, {
      forceInstalled: true,
      forceEnabled: true,
      runtimeSurfaces: ['platform', 'workspace'],
      managerSurfaces: ['platform'],
      workspaceAccess: 'always'
    })
  }
  // SMTP transport is the OSS path for sending email (cloud uses Cloudflare).
  // Register it only in self-hosted builds; the notifications-email channel
  // picks whichever transport is configured via the core registry.
  if (isSelfHostedDeployment()) {
    await pluginRegistry.register(emailSmtpPlugin, {
      forceInstalled: true,
      forceEnabled: true,
      runtimeSurfaces: ['platform', 'workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'always'
    })
    await pluginRegistry.register(cloudConnectionPlugin, {
      // Support is a primary product path, and both relays stay dormant until
      // a person uses them. Administrators can still disable the connection
      // install-wide or per workspace from the plugin manager.
      defaultEnabled: true,
      runtimeSurfaces: ['workspace'],
      managerSurfaces: ['platform', 'workspace'],
      workspaceAccess: 'controlled'
    })
  }
  await pluginRegistry.register(modelStudioPlugin, {
    defaultEnabled: true,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsNtfyPlugin, {
    // Notification channels run on both surfaces: workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsDiscordPlugin, {
    // Notification channels run on both surfaces: workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsBrowserPlugin, {
    // Notification channels run on both surfaces: workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsMobilePlugin, {
    defaultEnabled: true, runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'], workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsDesktopPlugin, {
    defaultEnabled: true, runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'], workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsEmailPlugin, {
    // Notification channels run on both surfaces: workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(plateClearingPlugin, {
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(firmwareUpdatesPlugin, {
    // On by default on every deployment: firmware awareness is expected core
    // printer functionality, and its UI is inert until an update actually
    // exists. Installs whose operator explicitly disabled it keep that choice
    // (the persisted _enabled row wins over this default).
    defaultEnabled: true,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(bambuCloudSyncPlugin, {
    // ON by default, on existing installs as well as new ones (nothing writes an `_enabled` row
    // until someone toggles it, so a raised default reaches installs that never touched this;
    // anyone who explicitly turned it off keeps that choice).
    //
    // It was off on the reasoning that it "holds a credential for the user's whole Bambu account
    // and reaches an external service". Enabling is not connecting: with no account linked this
    // plugin holds no credential, contacts nothing, and never polls (see its module header, and
    // the one scheduled task it owns is token RENEWAL, which presupposes a connection). All being
    // enabled does is offer the link, which is the choice the old default was trying to protect,
    // made where the user can see it instead of hidden behind an unrelated plugin toggle. Most
    // people slicing here have their tuned filament and process presets in a Bambu account, and
    // an install that does not want it can turn it off or remove it and keep a working preset
    // manager.
    defaultEnabled: true,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(ordersPlugin, {
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(filamentManagerPlugin, {
    defaultEnabled: true,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(calibrationPlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(printQueuePlugin, {
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(homeAssistantPlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  await pluginRegistry.register(maintenancePlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
  // Off by default like the other external-service integrations: the provider-page
  // flow is unusable without the companion Chrome extension installed.
  await pluginRegistry.register(remoteImportsPlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['workspace'],
    managerSurfaces: ['platform', 'workspace'],
    workspaceAccess: 'controlled'
  })
}
