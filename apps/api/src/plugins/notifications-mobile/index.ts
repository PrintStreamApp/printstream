/** Android notification plugin: personal enrolment, test delivery, and native FCM event fan-out. */
import { randomUUID } from 'node:crypto'
import { mobilePushRegistrationSchema, mobileRelayGrantSchema } from '@printstream/shared'
import type { ApiPlugin } from '../../plugin/types.js'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { badRequest, forbidden } from '../../lib/http-error.js'
import { readRequestOrigin } from '../../lib/request-helpers.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { registerMobileNotificationTransport } from '../../lib/mobile-notification-capability.js'
import { mayReceiveMobileNotifications } from './access.js'
import { requestNativeNotificationAccount } from '../../lib/native-notification-access.js'
import { MobileSubscriptions } from './subscriptions.js'
import { mobileDeliveryTransport } from './transport.js'
import { mobileNotificationHandler } from './delivery.js'

export const notificationsMobilePlugin: ApiPlugin = {
  name: 'notifications-mobile', version: '1.0.0',
  description: 'Native Android notifications with print details and camera snapshots.',
  async register(context) {
    const subscriptions = new MobileSubscriptions(context)
    const transport = mobileDeliveryTransport()
    const isMobilePushConfigured = () => transport !== 'unavailable'
    if (transport !== 'unavailable') context.onShutdown(registerMobileNotificationTransport(transport))
    context.router.use(async (request, _response, next) => {
      const account = requestNativeNotificationAccount(request)
      if (!await mayReceiveMobileNotifications(context, account, request.workspace?.id ?? null)) {
        throw forbidden('Notification enrolment requires membership in this scope.')
      }
      next()
    })
    context.router.get('/', (_request, response) => response.json({ configured: isMobilePushConfigured(), transport }))

    context.router.post('/status', async (request, response) => {
      skipRequestAuditLog(request) // Read-only; tokens must stay out of URLs/logs.
      const parsed = mobilePushRegistrationSchema.safeParse(request.body)
      if (!parsed.success) throw badRequest('Invalid device registration')
      const userId = requestNativeNotificationAccount(request)
      const devices = await subscriptions.read(request.workspace?.id ?? null)
      response.json({ configured: isMobilePushConfigured(), registered: devices.some((entry) =>
        entry.userId === userId && entry.bindingId === parsed.data.bindingId && entry.token === parsed.data.token) })
    })
    context.router.post('/subscriptions', async (request, response) => {
      if (!isMobilePushConfigured()) throw badRequest('Native push is not configured on this server.')
      const parsed = mobilePushRegistrationSchema.safeParse(request.body)
      if (!parsed.success) throw badRequest('Invalid device registration')
      const origin = readRequestOrigin(request)
      if (parsed.data.transport !== transport || (transport === 'relay' && !mobileRelayGrantSchema.safeParse(parsed.data.token).success)) {
        throw badRequest('Device enrollment does not match this server transport.')
      }
      if (!origin) throw badRequest('Server origin is required')
      const userId = requestNativeNotificationAccount(request)
      await subscriptions.update(request.workspace?.id ?? null, (entries) => [
        ...entries.filter((entry) => entry.token !== parsed.data.token && entry.bindingId !== parsed.data.bindingId),
        { ...parsed.data, userId, origin: new URL(origin).origin, updatedAt: Date.now() }
      ])
      annotateRequestAuditLog(request, { action: 'subscribe-mobile-push', resource: 'notifications', summary: 'Enabled native notifications on this device.' })
      response.status(201).json({ configured: true, registered: true })
    })
    context.router.delete('/subscriptions', async (request, response) => {
      const parsed = mobilePushRegistrationSchema.pick({ bindingId: true }).safeParse(request.body)
      if (!parsed.success) throw badRequest('Invalid device registration')
      const userId = requestNativeNotificationAccount(request)
      await subscriptions.update(request.workspace?.id ?? null, (entries) => entries.filter((entry) =>
        !(entry.userId === userId && entry.bindingId === parsed.data.bindingId)))
      annotateRequestAuditLog(request, { action: 'unsubscribe-mobile-push', resource: 'notifications', summary: 'Disabled native notifications on this device.' })
      response.json({ registered: false, configured: isMobilePushConfigured() })
    })
    const deliver = mobileNotificationHandler(context, subscriptions)
    context.onShutdown(subscribePrinterNotifications(context.printerEvents, async (message) => { await deliver(message) }, {
      shouldHandleWorkspaceId: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
      onError: () => context.logger.warn('Native notification fan-out failed')
    }))
    context.router.post('/test', async (request, response) => {
      const userId = requestNativeNotificationAccount(request)
      const accepted = await deliver({ id: randomUUID(), category: 'system', level: 'info', title: 'PrintStream notifications are ready',
        body: 'Print updates and alerts will appear here, even when the app is closed.', timestamp: new Date().toISOString(),
        workspaceId: request.workspace?.id, targetUserIds: [userId], url: '/' })
      if (!accepted) throw badRequest('No device accepted the test. Check enrolment and server push configuration.')
      annotateRequestAuditLog(request, { action: 'test-mobile-push', resource: 'notifications', summary: 'Requested a native test notification.' })
      response.status(202).json({ accepted })
    })
  }
}
