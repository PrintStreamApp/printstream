import type { ApiPluginInfo } from '../../lib/pluginSettings'
import { readStoredValue, writeStoredValue } from '../../lib/browserStorageKeys'
import { enrollmentPromptDismissedKey } from './storageKeys'

interface BrowserNotificationsSupportState {
  secureContext: boolean
  notification: boolean
  serviceWorker: boolean
  pushManager: boolean
}

export interface BrowserNotificationEnrollmentPromptState {
  pluginEnabled: boolean
  support: BrowserNotificationsSupportState
  permission: NotificationPermission
  /**
   * Whether the CURRENT workspace already delivers to this device. A device
   * subscribed only for other workspaces still gets the prompt, since
   * enablement is per workspace; the dismissed flag is what keeps that from
   * turning into a nag.
   */
  registeredInWorkspace: boolean
  dismissed: boolean
}

export function shouldShowBrowserNotificationEnrollmentPrompt(
  state: BrowserNotificationEnrollmentPromptState
): boolean {
  return state.pluginEnabled
    && state.support.secureContext
    && state.support.notification
    && state.support.serviceWorker
    && state.support.pushManager
    && state.permission !== 'denied'
    && !state.registeredInWorkspace
    && !state.dismissed
}

export function isBrowserNotificationsPluginEnabled(plugins: ApiPluginInfo[]): boolean {
  const plugin = plugins.find((entry) => entry.name === 'notifications-browser')
  return Boolean(plugin?.availableInCurrentContext && plugin.installed && plugin.enabled)
}

export function readEnrollmentPromptDismissed(): boolean {
  return readStoredValue(enrollmentPromptDismissedKey) === '1'
}

export function dismissEnrollmentPrompt(): void {
  // Best-effort: after a storage failure the prompt may reappear next load.
  writeStoredValue(enrollmentPromptDismissedKey, '1')
}