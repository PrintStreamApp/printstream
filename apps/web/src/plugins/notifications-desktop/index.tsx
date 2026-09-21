/** Desktop account preferences and opt-in overlay; native behavior stays inert in browsers. */
import type { WebPlugin } from '../../plugin/types'
import { DesktopNotificationAccountSection } from './DesktopNotificationAccountSection'
import { DesktopNotificationSettings } from './DesktopNotificationSettings'

export const notificationsDesktopPlugin: WebPlugin = {
  name: 'notifications-desktop', version: '1.0.0',
  description: 'Personal notifications for the desktop app.',
  runtimeSurfaces: ['platform', 'workspace'],
  slots: [
    { name: 'account.notifications', component: DesktopNotificationAccountSection, order: 9 },
    { name: 'shell.overlays', component: DesktopNotificationSettings, order: 21 }
  ]
}
