/**
 * Email notifications plugin (built-in).
 *
 * Emails opted-in users on notification events. In a tenant workspace the
 * recipients are opted-in members (per-tenant opt-in) for printer events; at
 * the platform scope the recipients are opted-in platform users for
 * platform events (bridge crashes, deployment-registered operator events).
 * Message formatting is delegated to the shared notification helper; delivery
 * goes through the core email-transport registry (Cloudflare in cloud, SMTP in
 * OSS) so this channel never depends on a specific transport.
 */
import { AUTHENTICATION_REQUIRED_MESSAGE, requireAuthenticatedCurrentUser } from '../../lib/authorization.js'
import { annotateRequestAuditLog } from '../../lib/audit-logs.js'
import { isEmailDeliveryConfigured } from '../../lib/email-delivery.js'
import { unauthorized } from '../../lib/http-error.js'
import { assertPlatformScopeActor, requestNotificationScope } from '../../lib/notification-scope.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import type { ApiPlugin } from '../../plugin/types.js'
import { createEmailNotificationHandler } from './delivery.js'
import { readEmailSubscribers, writeEmailSubscribers } from '../../lib/notification-subscribers.js'

export const notificationsEmailPlugin: ApiPlugin = {
  name: 'notifications-email',
  version: '0.1.0',
  description: 'Email workspace members about printer notifications.',
  async register(context) {
    function currentUserId(request: import('express').Request): string {
      if (request.auth.actor.type !== 'user') throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
      return request.auth.actor.userId
    }

    context.router.get('/', requireAuthenticatedCurrentUser(), async (request, response) => {
      const scope = requestNotificationScope(context, request)
      if (!scope.tenantId) assertPlatformScopeActor(request)
      const userId = currentUserId(request)
      const subscribers = await readEmailSubscribers(scope.settings)
      response.json({
        emailConfigured: await isEmailDeliveryConfigured(),
        subscribed: subscribers.includes(userId)
      })
    })

    context.router.post('/subscription', requireAuthenticatedCurrentUser(), async (request, response) => {
      const scope = requestNotificationScope(context, request)
      if (!scope.tenantId) assertPlatformScopeActor(request)
      const userId = currentUserId(request)
      const subscribers = await readEmailSubscribers(scope.settings)
      if (!subscribers.includes(userId)) {
        await writeEmailSubscribers(scope.settings, [...subscribers, userId])
      }
      annotateRequestAuditLog(request, {
        action: 'subscribe-email-notifications',
        resource: 'email notifications',
        summary: 'Opted in to print notification emails.',
        metadata: { userId, subscribed: true }
      })
      response.json({ subscribed: true })
    })

    context.router.delete('/subscription', requireAuthenticatedCurrentUser(), async (request, response) => {
      const scope = requestNotificationScope(context, request)
      if (!scope.tenantId) assertPlatformScopeActor(request)
      const userId = currentUserId(request)
      const subscribers = await readEmailSubscribers(scope.settings)
      if (subscribers.includes(userId)) {
        await writeEmailSubscribers(scope.settings, subscribers.filter((id) => id !== userId))
      }
      annotateRequestAuditLog(request, {
        action: 'unsubscribe-email-notifications',
        resource: 'email notifications',
        summary: 'Opted out of print notification emails.',
        metadata: { userId, subscribed: false }
      })
      response.json({ subscribed: false })
    })

    const handle = createEmailNotificationHandler(context)
    const off = subscribePrinterNotifications(context.printerEvents, handle, {
      onError: (error) => context.logger.warn('failed to deliver email notification', error),
      shouldHandleTenantId: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true
    })
    context.onShutdown(off)
  }
}
