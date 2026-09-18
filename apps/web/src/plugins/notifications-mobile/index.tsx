/** One Android notification selection at sign-in, reused by App settings; delivery stays server-owned. */
import type { WebPlugin } from '../../plugin/types'
import { MobileNotificationsAccountSection } from './MobileNotificationsAccountSection'
import { MobileNotificationSetupOffer } from './MobileNotificationSetupOffer'

export const notificationsMobilePlugin: WebPlugin = {
  name: 'notifications-mobile', version: '1.0.0',
  description: 'Native Android notifications with print details and camera snapshots.',
  runtimeSurfaces: ['platform', 'workspace'],
  slots: [
    { name: 'account.notifications', component: MobileNotificationsAccountSection, order: 9 },
    { name: 'shell.overlays', component: MobileNotificationSetupOffer, order: 20 }
  ]
}
