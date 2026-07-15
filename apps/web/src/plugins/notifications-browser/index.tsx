/**
 * Browser-native notifications plugin (web side).
 *
 * Pairs with the API plugin `notifications-browser`, which signs and
 * sends Web Push messages to subscribed browsers. The actual
 * notification is shown by the service worker (see
 * `apps/web/public/push-handler.js`), so notifications fire even when
 * no PrintStream tab is open.
 *
 * Enablement is PER WORKSPACE, per device: the browser keeps one push
 * subscription for the origin and the server registers its endpoint with
 * each workspace the user enables (see `subscription.ts`). This entry
 * contributes the settings panel and the once-per-device enrollment prompt.
 */
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { WebPlugin } from '../../plugin/types'
import { waitForAuthBootstrapData, waitForPluginCatalogData } from '../../lib/appShellQueryData'
import { toast } from '../../lib/toast'
import { BrowserNotificationsPanel } from './BrowserNotificationsPanel'
import {
  detectBrowserNotificationsSupport,
  enableBrowserNotificationsInCurrentWorkspace,
  getBrowserNotificationsScopeState
} from './subscription'
import {
  dismissEnrollmentPrompt,
  isBrowserNotificationsPluginEnabled,
  readEnrollmentPromptDismissed,
  shouldShowBrowserNotificationEnrollmentPrompt
} from './prompt'

async function promptForBrowserNotificationEnrollmentOnAppLoad(): Promise<void> {
  const support = detectBrowserNotificationsSupport()
  if (typeof window === 'undefined') return

  let bootstrap
  try {
    bootstrap = await waitForAuthBootstrapData()
  } catch {
    return
  }

  if (bootstrap.authEnabled && !bootstrap.permissions.includes(SETTINGS_MANAGE_PERMISSION)) {
    return
  }

  let pluginEnabled = false
  try {
    const catalog = await waitForPluginCatalogData()
    pluginEnabled = isBrowserNotificationsPluginEnabled(catalog.plugins)
  } catch {
    return
  }

  // If the scope lookup fails we cannot tell whether this workspace is
  // registered; suppress the prompt rather than nag a device that is set up.
  const scopeState = await getBrowserNotificationsScopeState()
    .catch(() => ({ deviceSubscribed: true, registeredInWorkspace: true }))
  if (!shouldShowBrowserNotificationEnrollmentPrompt({
    pluginEnabled,
    support,
    permission: support.notification ? Notification.permission : 'denied',
    registeredInWorkspace: scopeState.registeredInWorkspace,
    dismissed: readEnrollmentPromptDismissed()
  })) {
    return
  }

  toast.info({
    message: 'Enable browser background notifications for this workspace on this device?',
    durationMs: 0,
    action: {
      label: 'Enable',
      onClick: async () => {
        try {
          await enableBrowserNotificationsInCurrentWorkspace()
          toast.success('Browser notifications enabled for this workspace on this device')
        } catch (caught) {
          toast.error((caught as Error).message)
        }
      }
    },
    onClose: (reason) => {
      if (reason === 'dismiss') dismissEnrollmentPrompt()
    }
  })
}

export const notificationsBrowserPlugin: WebPlugin = {
  name: 'notifications-browser',
  version: '0.3.0',
  description: 'Background OS notifications via Web Push (works when the app is closed).',
  settingsPanel: BrowserNotificationsPanel,
  init() {
    void promptForBrowserNotificationEnrollmentOnAppLoad()
  }
}
