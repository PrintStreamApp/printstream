/**
 * Browser-native notifications plugin (server side).
 *
 * Delivers printer notifications via the Web Push protocol so OS
 * notifications fire even when no PrintStream tab is open. Each browser
 * (per-device) registers a `PushSubscription`; on every notification
 * we sign a payload with this plugin's VAPID keypair and POST it to
 * the matching push service. The browser's service worker receives
 * the push and calls `showNotification`.
 *
 * Routes:
 * - `GET /api/plugins/notifications-browser` — public key + subscription count.
 * - `POST /api/plugins/notifications-browser/subscriptions` — register a subscription.
 * - `DELETE /api/plugins/notifications-browser/subscriptions` — unregister by endpoint.
 * - `POST /api/plugins/notifications-browser/dismissals` — sync a notification
 *   dismissal to the actor's other devices (excluded from the audit trail).
 *
 * Audit note: subscription changes are annotated, but push endpoint URLs are
 * capability URLs (effectively secrets) and must never appear in audit
 * metadata or logs.
 *
 * ## Tenant scoping
 *
 * VAPID keys are server-wide (one keypair shared by all tenants).
 * Push subscriptions are scoped: each tenant has its own list stored via
 * `context.settings.forTenant(tenantId)`, and the platform workspace keeps
 * its own list in the plugin's base store for platform-scope events (bridge
 * crashes, operator events). Notifications are only delivered to the
 * subscriptions belonging to the scope the event originated from.
 */
import { z } from 'zod'
import type { Request } from 'express'
import { SETTINGS_MANAGE_PERMISSION } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import type { ApiPlugin, ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { requireRequestPermission } from '../../lib/authorization.js'
import { badRequest } from '../../lib/http-error.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { WebPushDelivery, type StoredSubscription } from './push.js'

const subscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1)
  })
})

const subscribeBodySchema = z.object({
  subscription: subscriptionSchema
})

const unsubscribeBodySchema = z.object({
  endpoint: z.string().url()
})

const dismissalBodySchema = z.object({
  notificationId: z.string().min(1).optional(),
  tag: z.string().min(1).optional()
}).refine(
  (value) => value.notificationId !== undefined || value.tag !== undefined,
  'Notification id or tag is required.'
)

export const notificationsBrowserPlugin: ApiPlugin = {
  name: 'notifications-browser',
  version: '0.2.0',
  description: 'Background OS notifications via Web Push (works when the app is closed).',
  async register(context) {
    // VAPID keys are global (per-server), stored in the base plugin store.
    // Subscriptions are tenant-scoped: each tenant's browsers only receive
    // notifications for that tenant's printers.
    const delivery = new WebPushDelivery(context.settings, context.logger)
    await delivery.load()

    // Per-scope delivery instances, keyed by tenantId; the platform scope
    // (null) uses the base instance, whose store also owns the VAPID keys.
    const tenantDeliveries = new Map<string, WebPushDelivery>()
    const getOrCreateScopedDelivery = async (tenantId: string | null): Promise<WebPushDelivery> => {
      if (!tenantId) return delivery
      let d = tenantDeliveries.get(tenantId)
      if (!d) {
        d = new WebPushDelivery(context.settings.forTenant(tenantId), context.logger)
        await d.load({ includeVapid: false })
        // Tenant deliveries share the server-wide VAPID identity; they only
        // own the per-tenant subscription list.
        d.setVapidKeys(delivery.getPublicKey(), delivery.getPrivateKey(), delivery.getSubject())
        tenantDeliveries.set(tenantId, d)
      }
      return d
    }

    context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = request.tenant?.id ?? null
      const tenantDelivery = await getOrCreateScopedDelivery(tenantId)
      response.json({
        publicKey: delivery.getPublicKey(),
        subscriptions: tenantDelivery.size()
      })
    })

    context.router.post('/subscriptions', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = request.tenant?.id ?? null
      // The push endpoint is a capability URL; deliberately no metadata here.
      annotateRequestAuditLog(request, {
        action: 'subscribe-browser-push',
        resource: 'notifications',
        summary: 'Registered this browser for push notifications.'
      })
      const tenantDelivery = await getOrCreateScopedDelivery(tenantId)
      const parsed = subscribeBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid subscription payload')
      }
      // Platform users browsing a workspace via support access hold
      // `settings.manage` for that tenant but are not real members, so they
      // must not receive its push notifications. Only genuine tenant members
      // (and the tenant's own service accounts) may register a device. If a
      // non-member's browser re-registers an endpoint stored before this
      // guard existed, drop it so the stale subscription self-heals.
      if (!(await requesterBelongsToScope(context, request.auth, tenantId))) {
        await tenantDelivery.removeSubscription(parsed.data.subscription.endpoint)
        response.status(403).json({ error: 'Browser notifications are only available to workspace members.' })
        return
      }
      await tenantDelivery.addSubscription({
        subscription: parsed.data.subscription,
        userAgent: extractUserAgent(request),
        actorKey: buildNotificationActorKey(request.auth)
      })
      response.status(201).json({ subscriptions: tenantDelivery.size() })
    })

    context.router.delete('/subscriptions', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const tenantId = request.tenant?.id ?? null
      annotateRequestAuditLog(request, {
        action: 'unsubscribe-browser-push',
        resource: 'notifications',
        summary: 'Unregistered a browser push notification subscription.'
      })
      const tenantDelivery = await getOrCreateScopedDelivery(tenantId)
      const parsed = unsubscribeBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid unsubscribe payload')
      }
      const removed = await tenantDelivery.removeSubscription(parsed.data.endpoint)
      annotateRequestAuditLog(request, { metadata: { removed } })
      response.json({ removed, subscriptions: tenantDelivery.size() })
    })

    context.router.post('/dismissals', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      // Fires once per dismissed notification just to sync the dismissal to
      // the actor's other devices — no durable state changes, so a row per
      // dismissal would only be audit noise.
      skipRequestAuditLog(request)
      const tenantId = request.tenant?.id ?? null
      const tenantDelivery = await getOrCreateScopedDelivery(tenantId)
      const parsed = dismissalBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid dismissal payload')
      }

      const actorKey = buildNotificationActorKey(request.auth)
      if (!actorKey) {
        throw badRequest('Notification dismissals require an authenticated actor.')
      }

      await tenantDelivery.sendToActor(actorKey, {
        type: 'dismiss',
        notificationId: parsed.data.notificationId,
        tag: parsed.data.tag
      })
      response.status(202).json({ ok: true })
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        const tenantId = message.tenantId ?? null
        const tenantDelivery = await getOrCreateScopedDelivery(tenantId)
        // Filter out subscriptions whose owning user no longer belongs to the
        // scope (membership for tenants, the platform flag at the platform
        // scope). This also clears any stale cross-scope subscriptions that
        // predate the registration guard above without manual cleanup.
        const deliverable = await resolveDeliverableEndpoints(context, tenantId, tenantDelivery.listSubscriptions())
        await tenantDelivery.sendMatching(message, (entry) => deliverable.has(entry.endpoint))
      },
      {
        onError: (error) => context.logger.warn('web-push fanout failed', error),
        shouldHandleTenantId: (tenantId) => context.isEnabledForTenant?.(tenantId) ?? true
      }
    )
    context.onShutdown(off)
  }
}

const USER_ACTOR_PREFIX = 'user:'

/** Extract the user id from a `user:<id>` actor key, or null for other actors. */
function parseUserActorId(actorKey: string | undefined): string | null {
  if (!actorKey || !actorKey.startsWith(USER_ACTOR_PREFIX)) return null
  const userId = actorKey.slice(USER_ACTOR_PREFIX.length)
  return userId.length > 0 ? userId : null
}

/**
 * Resolve the set of subscription endpoints eligible to receive a scope's
 * notifications. Subscriptions tied to a user actor are only deliverable when
 * that user currently belongs to the scope (tenant membership, or the
 * platform-user flag for the platform scope). Service-account and legacy
 * (actor-less) subscriptions are always deliverable.
 */
async function resolveDeliverableEndpoints(
  context: ApiPluginContext,
  tenantId: string | null,
  subscriptions: readonly StoredSubscription[]
): Promise<Set<string>> {
  const userEndpoints = new Map<string, string[]>()
  const allowed = new Set<string>()
  for (const subscription of subscriptions) {
    const userId = parseUserActorId(subscription.actorKey)
    if (userId === null) {
      allowed.add(subscription.endpoint)
      continue
    }
    const endpoints = userEndpoints.get(userId) ?? []
    endpoints.push(subscription.endpoint)
    userEndpoints.set(userId, endpoints)
  }

  if (userEndpoints.size > 0) {
    const memberIds = tenantId
      ? new Set((await context.prisma.authTenantMembership.findMany({
          where: { tenantId, userId: { in: [...userEndpoints.keys()] } },
          select: { userId: true }
        })).map((member) => member.userId))
      : new Set((await context.prisma.authUser.findMany({
          where: { id: { in: [...userEndpoints.keys()] }, isPlatformUser: true },
          select: { id: true }
        })).map((user) => user.id))
    for (const [userId, endpoints] of userEndpoints) {
      if (!memberIds.has(userId)) continue
      for (const endpoint of endpoints) allowed.add(endpoint)
    }
  }

  return allowed
}

/**
 * Whether the requester may register a push subscription for the scope.
 * Tenant scope: genuine tenant members and the tenant's own service accounts
 * qualify; platform users with support access (but no membership) do not.
 * Platform scope: platform users only.
 */
async function requesterBelongsToScope(
  context: ApiPluginContext,
  auth: RequestAuthContext,
  tenantId: string | null
): Promise<boolean> {
  if (!tenantId) {
    return auth.actor.type === 'user' && Boolean(auth.actor.isPlatformUser)
  }
  if (auth.actor.type === 'service-account') {
    return auth.actor.tenant?.id === tenantId
  }
  if (auth.actor.type === 'user') {
    const membership = await context.prisma.authTenantMembership.findFirst({
      where: { tenantId, userId: auth.actor.userId },
      select: { userId: true }
    })
    return membership !== null
  }
  return false
}

function extractUserAgent(request: Request): string | undefined {
  const value = request.headers['user-agent']
  if (typeof value === 'string' && value.length > 0) return value.slice(0, 256)
  return undefined
}

function buildNotificationActorKey(auth: RequestAuthContext): string | undefined {
  if (auth.actor.type === 'user') {
    return `user:${auth.actor.userId}`
  }

  if (auth.actor.type === 'service-account') {
    return `service-account:${auth.actor.serviceAccountId}`
  }

  return undefined
}
