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
import type { WebPlugin } from '../../plugin/types'
import { isNativeApp } from '../../native/bridge'
import { waitForAuthBootstrapData, waitForPluginCatalogData } from '../../lib/appShellQueryData'
import { scopeAcceptsPersonalNotifications } from '../../lib/personalNotificationScope'
import { toast } from '../../lib/toast'
import { BrowserNotificationsAccountSection } from './BrowserNotificationsAccountSection'
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
import { installNotificationVisibilityResponder } from './visibilityResponder'

async function promptForBrowserNotificationEnrollmentOnAppLoad(): Promise<void> {
  const support = detectBrowserNotificationsSupport()
  if (typeof window === 'undefined') return

  let bootstrap
  try {
    bootstrap = await waitForAuthBootstrapData()
  } catch {
    return
  }

  // Being able to enrol is the only bar. Enrolling a device is not gated on
  // `settings.manage`, so neither is being offered it: that gate is what made
  // every non-admin miss the one prompt that turns notifications on. It IS
  // gated on the scope accepting this actor, because `enable()` asks the
  // browser for notification permission before it calls the API, so prompting
  // someone the server will refuse costs them a permanent permission grant.
  if (bootstrap.authEnabled && bootstrap.actor.type === 'anonymous') {
    return
  }
  if (bootstrap.authEnabled && !scopeAcceptsPersonalNotifications(bootstrap)) {
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
  // Both surfaces: a platform operator enrols a device for platform events
  // (bridge crashes) exactly as a member does for a workspace's prints, and
  // the default (`workspace` only) would hide the account card from them.
  runtimeSurfaces: ['platform', 'workspace'],
  settingsPanel: BrowserNotificationsPanel,
  slots: [
    // Enrolling this browser is personal, per-device state, so it also lives
    // on the account page, which every member can open. Settings cannot be
    // the only home for it: that screen is admin-only.
    {
      name: 'account.notifications',
      component: BrowserNotificationsAccountSection,
      order: 10
    }
  ],
  init() {
    if (isNativeApp()) return
    // Lets the service worker suppress pushes whose subject is on screen.
    installNotificationVisibilityResponder()
    void promptForBrowserNotificationEnrollmentOnAppLoad()
  }
}
