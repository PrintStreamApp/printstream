import type { ApiPluginInfo } from '../../lib/pluginSettings'

const ENROLLMENT_PROMPT_DISMISSED_KEY = 'bambu.notifications-browser.enrollment-prompt-dismissed.v1'

interface BrowserNotificationsSupportState {
  notification: boolean
  serviceWorker: boolean
  pushManager: boolean
}

export interface BrowserNotificationEnrollmentPromptState {
  pluginEnabled: boolean
  support: BrowserNotificationsSupportState
  permission: NotificationPermission
  subscribed: boolean
  dismissed: boolean
}

export function shouldShowBrowserNotificationEnrollmentPrompt(
  state: BrowserNotificationEnrollmentPromptState
): boolean {
  return state.pluginEnabled
    && state.support.notification
    && state.support.serviceWorker
    && state.support.pushManager
    && state.permission !== 'denied'
    && !state.subscribed
    && !state.dismissed
}

export function isBrowserNotificationsPluginEnabled(plugins: ApiPluginInfo[]): boolean {
  const plugin = plugins.find((entry) => entry.name === 'notifications-browser')
  return Boolean(plugin?.availableInCurrentContext && plugin.installed && plugin.enabled)
}

export function readEnrollmentPromptDismissed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(ENROLLMENT_PROMPT_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissEnrollmentPrompt(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ENROLLMENT_PROMPT_DISMISSED_KEY, '1')
  } catch {
    // Ignore storage failures; the prompt may reappear next load.
  }
}