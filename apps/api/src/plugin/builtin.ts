/**
 * Built-in plugin loader. Lists the plugins shipped with the core app and
 * registers them at startup with their install/enable defaults and surfaces.
 *
 * This file only wires the FIRST-PARTY built-ins. Third-party plugins are a
 * separate path: they are uploaded as `.zip` archives, extracted into
 * `PLUGINS_DIR`, and re-loaded on each boot by `loadInstalledExternalPlugins`
 * (`plugin/installer.ts`, invoked from `src/index.ts`) — not registered here.
 */
import { pluginRegistry } from './registry.js'
import { isSelfHostedDeployment } from '../lib/deployment-mode.js'
import { authPasswordPlugin } from '../plugins/auth-password/index.js'
import { authOauthPlugin } from '../plugins/auth-oauth/index.js'
import { notificationsNtfyPlugin } from '../plugins/notifications-ntfy/index.js'
import { notificationsDiscordPlugin } from '../plugins/notifications-discord/index.js'
import { notificationsBrowserPlugin } from '../plugins/notifications-browser/index.js'
import { notificationsEmailPlugin } from '../plugins/notifications-email/index.js'
import { emailSmtpPlugin } from '../plugins/email-smtp/index.js'
import { modelStudioPlugin } from '../plugins/model-studio/index.js'
import { plateClearingPlugin } from '../plugins/plate-clearing/index.js'
import { firmwareUpdatesPlugin } from '../plugins/firmware-updates/index.js'
import { ordersPlugin } from '../plugins/orders/index.js'
import { filamentManagerPlugin } from '../plugins/filament-manager/index.js'
import { calibrationPlugin } from '../plugins/calibration/index.js'
import { printQueuePlugin } from '../plugins/print-queue/index.js'
import { homeAssistantPlugin } from '../plugins/home-assistant/index.js'

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
      runtimeSurfaces: ['platform', 'tenant'],
      managerSurfaces: ['platform'],
      tenantAccess: 'always'
    })
  } else {
    await pluginRegistry.register(authOauthPlugin, {
      forceInstalled: true,
      forceEnabled: true,
      runtimeSurfaces: ['platform', 'tenant'],
      managerSurfaces: ['platform'],
      tenantAccess: 'always'
    })
  }
  // SMTP transport is the OSS path for sending email (cloud uses Cloudflare).
  // Register it only in self-hosted builds; the notifications-email channel
  // picks whichever transport is configured via the core registry.
  if (isSelfHostedDeployment()) {
    await pluginRegistry.register(emailSmtpPlugin, {
      forceInstalled: true,
      forceEnabled: true,
      runtimeSurfaces: ['platform', 'tenant'],
      managerSurfaces: ['platform', 'tenant'],
      tenantAccess: 'always'
    })
  }
  await pluginRegistry.register(modelStudioPlugin, {
    defaultEnabled: true,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsNtfyPlugin, {
    // Notification channels run on both surfaces: tenant workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsDiscordPlugin, {
    // Notification channels run on both surfaces: tenant workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsBrowserPlugin, {
    // Notification channels run on both surfaces: tenant workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(notificationsEmailPlugin, {
    // Notification channels run on both surfaces: tenant workspaces deliver
    // printer events; the platform workspace delivers platform-scope events
    // (bridge crashes, deployment-registered operator events).
    runtimeSurfaces: ['platform', 'tenant'],
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
  await pluginRegistry.register(filamentManagerPlugin, {
    defaultEnabled: true,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(calibrationPlugin, {
    defaultEnabled: false,
    runtimeSurfaces: ['tenant'],
    managerSurfaces: ['platform', 'tenant'],
    tenantAccess: 'controlled'
  })
  await pluginRegistry.register(printQueuePlugin, {
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
