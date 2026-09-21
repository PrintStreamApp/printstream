/** Personal desktop alerts delivered directly without an external push provider. */
import { desktopNotificationQuerySchema } from '@printstream/shared'
import { z } from 'zod'
import type { ApiPlugin } from '../../plugin/types.js'
import { skipRequestAuditLog } from '../../lib/audit-logs.js'
import { badRequest, forbidden, unauthorized } from '../../lib/http-error.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { requestNativeNotificationAccount, mayReceiveNativeNotifications } from '../../lib/native-notification-access.js'
import { prepareNativeNotificationImage } from '../../lib/native-notification-images.js'
import { DesktopNotificationFeed } from './feed.js'

const desktopDismissalSchema = z.object({
  tag: z.string().min(1).max(500),
  notificationId: z.string().min(1).max(200).optional()
})

export const notificationsDesktopPlugin: ApiPlugin = {
  name: 'notifications-desktop', version: '1.0.0',
  description: 'Personal notifications for the desktop app.',
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
    context.router.post('/dismissals', async (request, response) => {
      // A click or Notification Center dismissal has no durable server state;
      // recording one audit row per gesture would obscure meaningful changes.
      skipRequestAuditLog(request)
      const parsed = desktopDismissalSchema.safeParse(request.body)
      if (!parsed.success) throw badRequest('Invalid notification dismissal.')
      const userId = requestNativeNotificationAccount(request)
      if (request.get('X-PrintStream-Notification-Account') !== userId) {
        throw unauthorized('The notification account has changed. Sign in again.')
      }
      if (userId.startsWith('anonymous:')) {
        response.status(202).json({ ok: true })
        return
      }
      if (!await mayReceiveNativeNotifications(context, userId, request.workspace?.id ?? null)) {
        throw forbidden('Notifications are unavailable in this scope.')
      }

      context.printerEvents.emit('notification.dismiss', {
        tag: parsed.data.tag,
        notificationId: parsed.data.notificationId,
        workspaceId: null,
        targetUserIds: [userId]
      })
      response.status(202).json({ ok: true })
    })
    context.onShutdown(subscribePrinterNotifications(context.printerEvents, async (message) => {
      feed.add(await prepareNativeNotificationImage(message, context.prisma))
    }, {
      shouldHandleWorkspaceId: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
      onError: () => context.logger.warn('Desktop notification preparation failed')
    }))
    const dismiss = (event: {
      tag: string
      notificationId?: string
      workspaceId: string | null
      targetUserIds?: string[]
    }) => {
      if (context.isEnabledForWorkspace?.(event.workspaceId) ?? true) feed.dismiss(event)
    }
    context.printerEvents.on('notification.dismiss', dismiss)
    context.onShutdown(() => {
      context.printerEvents.off('notification.dismiss', dismiss)
    })
  }
}
