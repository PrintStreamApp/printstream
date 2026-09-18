/** Personal Windows alerts, delivered directly to Windows apps without an external push provider. */
import { desktopNotificationQuerySchema } from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { badRequest, forbidden, unauthorized } from '../../lib/http-error.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { requestNativeNotificationAccount, mayReceiveNativeNotifications } from '../../lib/native-notification-access.js'
import { DesktopNotificationFeed } from './feed.js'

export const notificationsDesktopPlugin: ApiPlugin = {
  name: 'notifications-desktop', version: '1.0.0',
  description: 'Personal notifications for the Windows app.',
  async register(context) {
    const feed = new DesktopNotificationFeed()
    context.router.get('/', async (request, response) => {
      const userId = requestNativeNotificationAccount(request)
      const query = desktopNotificationQuerySchema.safeParse(request.query)
      if (!query.success) throw badRequest('Invalid notification cursor.')
      // A shared WebView cookie can change identity while a background read is
      // in flight. Device consent belongs to the enrolled actor, not that cookie.
      if (request.get('X-PrintStream-Notification-Account') !== userId) {
        throw unauthorized('The notification account has changed. Sign in again.')
      }
      const scope = request.workspace?.id ?? null
      if (!await mayReceiveNativeNotifications(context, userId, scope)) throw forbidden('Notifications are unavailable in this scope.')
      response.setHeader('Cache-Control', 'no-store')
      response.json(feed.read(scope, userId, query.data.cursor))
    })
    context.onShutdown(subscribePrinterNotifications(context.printerEvents, async (message) => {
      feed.add(message)
    }, {
      shouldHandleWorkspaceId: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
      onError: () => context.logger.warn('Windows notification preparation failed')
    }))
    const dismiss = (event: { tag: string; workspaceId: string | null; targetUserIds?: string[] }) => {
      if (context.isEnabledForWorkspace?.(event.workspaceId) ?? true) feed.dismiss(event)
    }
    context.printerEvents.on('notification.dismiss', dismiss)
    context.onShutdown(() => {
      context.printerEvents.off('notification.dismiss', dismiss)
    })
  }
}
