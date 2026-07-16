/**
 * Page-side answerer for the service worker's pre-display visibility check.
 *
 * Before showing a push notification, `public/push-handler.js` posts a
 * `notification-tag-visibility-check` message (carrying a reply MessagePort)
 * to each visible window client. We answer whether the tag's subject surface
 * is currently on screen (`lib/notificationTagVisibility.ts`); any "visible"
 * answer makes the service worker skip the OS notification for that push.
 */
import { isNotificationTagVisible } from '../../lib/notificationTagVisibility'

export function installNotificationVisibilityResponder(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data as { type?: unknown; tag?: unknown } | null
    if (!data || data.type !== 'notification-tag-visibility-check' || typeof data.tag !== 'string') return
    const port = event.ports[0]
    if (!port) return
    port.postMessage({ visible: isNotificationTagVisible(data.tag) })
  })
}
