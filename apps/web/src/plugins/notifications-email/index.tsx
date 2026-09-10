/**
 * Email notifications plugin (web side).
 *
 * The API plugin owns delivery; this contributes the per-user opt-in panel,
 * to the plugin manager and to the account page's Notifications section.
 */
import type { WebPlugin } from '../../plugin/types'
import { EmailNotificationsAccountSection } from './EmailNotificationsAccountSection'
import { EmailNotificationsPanel } from './EmailNotificationsPanel'

export const notificationsEmailWebPlugin: WebPlugin = {
  name: 'notifications-email',
  version: '0.1.0',
  description: 'Email workspace members about printer notifications.',
  // The panel already handles the platform scope (it opts into platform
  // events there); the default (`workspace` only) would hide its account card.
  runtimeSurfaces: ['platform', 'workspace'],
  settingsPanel: EmailNotificationsPanel,
  slots: [
    // A member's own opt-in, alongside browser push, on the page they can
    // reach without `settings.manage`.
    {
      name: 'account.notifications',
      component: EmailNotificationsAccountSection,
      order: 20
    }
  ]
}
