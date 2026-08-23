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
 * - `GET /api/plugins/notifications-browser`: public key + subscription count.
 * - `POST /api/plugins/notifications-browser/subscriptions`: register a subscription.
 * - `POST /api/plugins/notifications-browser/subscriptions/lookup`: whether an
 *   endpoint is registered in the current scope (POST because the endpoint is a
 *   capability URL that must stay out of query strings and logs).
 * - `DELETE /api/plugins/notifications-browser/subscriptions`: unregister by endpoint.
 * - `POST /api/plugins/notifications-browser/dismissals`: sync a notification
 *   dismissal to the actor's other devices (excluded from the audit trail).
 *
 * Audit note: subscription changes are annotated, but push endpoint URLs are
 * capability URLs (effectively secrets) and must never appear in audit
 * metadata or logs.
 *
 * ## Workspace scoping
 *
 * VAPID keys are server-wide (one keypair shared by all workspaces).
 * Push subscriptions are scoped: each workspace has its own list stored via
 * `context.settings.forWorkspace(workspaceId)`, and the platform workspace keeps
 * its own list in the plugin's base store for platform-scope events (bridge
 * crashes, operator events). Notifications are only delivered to the
 * subscriptions belonging to the scope the event originated from.
 *
 * A browser has exactly ONE push subscription per origin, so the same
 * endpoint is expected to appear in several scopes' lists, one entry per
 * workspace the user enabled notifications in on that device. Enabling a
 * workspace must therefore never invalidate the device's existing
 * subscription, and disabling removes the endpoint from that scope only.
 *
 * Messages carrying `targetUserIds` are personal rather than scope-wide and
 * route through `targeted-push.ts` (actor-key matching; cross-scope with
 * endpoint dedupe when the message has no workspace).
 *
 * Besides the HTTP dismissal sync above, the plugin listens for
 * `notification.dismiss` bus events (read-state dismissal: the notification's
 * subject was seen in the app) and retracts tag-matched notifications from
 * the targeted users' devices, or the whole originating scope when the
 * event carries no targets.
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
import { listWorkspaceScopesWithPluginSetting } from '../../lib/notification-scope.js'
import { WebPushDelivery, type StoredSubscription } from './push.js'
import { deliverTargetedPush } from './targeted-push.js'

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

const endpointBodySchema = z.object({
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
  version: '0.3.0',
  description: 'Background OS notifications via Web Push (works when the app is closed).',
  async register(context) {
    // VAPID keys are global (per-server), stored in the base plugin store.
    // Subscriptions are workspace-scoped: each workspace's browsers only receive
    // notifications for that workspace's printers.
    const delivery = new WebPushDelivery(context.settings, context.logger)
    await delivery.load()

    // Per-scope delivery instances, keyed by workspaceId; the platform scope
    // (null) uses the base instance, whose store also owns the VAPID keys.
    const workspaceDeliveries = new Map<string, WebPushDelivery>()
    const getOrCreateScopedDelivery = async (workspaceId: string | null): Promise<WebPushDelivery> => {
      if (!workspaceId) return delivery
      let d = workspaceDeliveries.get(workspaceId)
      if (!d) {
        d = new WebPushDelivery(context.settings.forWorkspace(workspaceId), context.logger)
        await d.load({ includeVapid: false })
        // Workspace deliveries share the server-wide VAPID identity; they only
        // own the per-workspace subscription list.
        d.setVapidKeys(delivery.getPublicKey(), delivery.getPrivateKey(), delivery.getSubject())
        workspaceDeliveries.set(workspaceId, d)
      }
      return d
    }

    context.router.get('/', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = request.workspace?.id ?? null
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      response.json({
        publicKey: delivery.getPublicKey(),
        subscriptions: workspaceDelivery.size()
      })
    })

    context.router.post('/subscriptions', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = request.workspace?.id ?? null
      // The push endpoint is a capability URL; deliberately no metadata here.
      annotateRequestAuditLog(request, {
        action: 'subscribe-browser-push',
        resource: 'notifications',
        summary: 'Registered this browser for push notifications.'
      })
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = subscribeBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid subscription payload')
      }
      // Platform users browsing a workspace via support access hold
      // `settings.manage` for that workspace but are not real members, so they
      // must not receive its push notifications. Only genuine workspace members
      // (and the workspace's own service accounts) may register a device. If a
      // non-member's browser re-registers an endpoint stored before this
      // guard existed, drop it so the stale subscription self-heals.
      if (!(await requesterBelongsToScope(context, request.auth, workspaceId))) {
        await workspaceDelivery.removeSubscription(parsed.data.subscription.endpoint)
        response.status(403).json({ error: 'Browser notifications are only available to workspace members.' })
        return
      }
      await workspaceDelivery.addSubscription({
        subscription: parsed.data.subscription,
        userAgent: extractUserAgent(request),
        actorKey: buildNotificationActorKey(request.auth)
      })
      response.status(201).json({ subscriptions: workspaceDelivery.size() })
    })

    context.router.post('/subscriptions/lookup', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      // Read-only status probe (fired on every settings-panel mount); a POST
      // only because the endpoint is a capability URL that must stay out of
      // query strings, no state changes, so no audit row.
      skipRequestAuditLog(request)
      const workspaceId = request.workspace?.id ?? null
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = endpointBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid lookup payload')
      }
      response.json({ registered: workspaceDelivery.hasSubscription(parsed.data.endpoint) })
    })

    context.router.delete('/subscriptions', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      const workspaceId = request.workspace?.id ?? null
      annotateRequestAuditLog(request, {
        action: 'unsubscribe-browser-push',
        resource: 'notifications',
        summary: 'Unregistered a browser push notification subscription.'
      })
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = endpointBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid unsubscribe payload')
      }
      const removed = await workspaceDelivery.removeSubscription(parsed.data.endpoint)
      annotateRequestAuditLog(request, { metadata: { removed } })
      response.json({ removed, subscriptions: workspaceDelivery.size() })
    })

    context.router.post('/dismissals', requireRequestPermission(SETTINGS_MANAGE_PERMISSION), async (request, response) => {
      // Fires once per dismissed notification just to sync the dismissal to
      // the actor's other devices, no durable state changes, so a row per
      // dismissal would only be audit noise.
      skipRequestAuditLog(request)
      const workspaceId = request.workspace?.id ?? null
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = dismissalBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid dismissal payload')
      }

      const actorKey = buildNotificationActorKey(request.auth)
      if (!actorKey) {
        throw badRequest('Notification dismissals require an authenticated actor.')
      }

      await workspaceDelivery.sendToActor(actorKey, {
        type: 'dismiss',
        notificationId: parsed.data.notificationId,
        tag: parsed.data.tag
      })
      response.status(202).json({ ok: true })
    })

    const off = subscribePrinterNotifications(
      context.printerEvents,
      async (message) => {
        const workspaceId = message.workspaceId ?? null
        if (message.targetUserIds && message.targetUserIds.length > 0) {
          const scopedDelivery = await getOrCreateScopedDelivery(workspaceId)
          const deliverable = message.workspaceId
            ? await resolveDeliverableEndpoints(context, workspaceId, scopedDelivery.listSubscriptions())
            : null
          await deliverTargetedPush({
            workspaceId,
            payload: message,
            targetUserIds: message.targetUserIds,
            getScopedDelivery: getOrCreateScopedDelivery,
            listSubscriptionWorkspaceScopes: () =>
              listWorkspaceScopesWithPluginSetting(context.prisma, context.pluginName, 'subscriptions'),
            isEnabledForWorkspace: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
            isDeliverableInScope: deliverable ? (entry) => deliverable.has(entry.endpoint) : undefined
          })
          return
        }
        const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
        // Filter out subscriptions whose owning user no longer belongs to the
        // scope (membership for workspaces, the platform flag at the platform
        // scope). This also clears any stale cross-scope subscriptions that
        // predate the registration guard above without manual cleanup.
        const deliverable = await resolveDeliverableEndpoints(context, workspaceId, workspaceDelivery.listSubscriptions())
        await workspaceDelivery.sendMatching(message, (entry) => deliverable.has(entry.endpoint))
      },
      {
        onError: (error) => context.logger.warn('web-push fanout failed', error),
        shouldHandleWorkspaceId: (workspaceId) => context.isEnabledForWorkspace?.(workspaceId) ?? true
      }
    )
    context.onShutdown(off)

    // Read-state dismissal: when a notification's subject was seen in the app
    // (e.g. a support thread was read), retract the delivered notification by
    // its tag: targeted at specific users' devices, or across the whole
    // originating scope when the event carries no targets.
    const handleDismiss = async (event: { tag: string; workspaceId: string | null; targetUserIds?: string[] }) => {
      const dismissPayload = { type: 'dismiss', tag: event.tag }
      if (event.targetUserIds && event.targetUserIds.length > 0) {
        await deliverTargetedPush({
          workspaceId: event.workspaceId,
          payload: dismissPayload,
          targetUserIds: event.targetUserIds,
          getScopedDelivery: getOrCreateScopedDelivery,
          listSubscriptionWorkspaceScopes: () =>
            listWorkspaceScopesWithPluginSetting(context.prisma, context.pluginName, 'subscriptions'),
          isEnabledForWorkspace: (scope) => context.isEnabledForWorkspace?.(scope) ?? true
        })
        return
      }
      if (!(context.isEnabledForWorkspace?.(event.workspaceId) ?? true)) return
      const scopedDelivery = await getOrCreateScopedDelivery(event.workspaceId)
      await scopedDelivery.sendToAll(dismissPayload)
    }
    const onDismiss = (event: { tag: string; workspaceId: string | null; targetUserIds?: string[] }) => {
      handleDismiss(event).catch((error) => context.logger.warn('web-push dismissal fanout failed', error))
    }
    context.printerEvents.on('notification.dismiss', onDismiss)
    context.onShutdown(() => {
      context.printerEvents.off('notification.dismiss', onDismiss)
    })
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
 * that user currently belongs to the scope (workspace membership, or the
 * platform-user flag for the platform scope). Service-account and legacy
 * (actor-less) subscriptions are always deliverable.
 */
async function resolveDeliverableEndpoints(
  context: ApiPluginContext,
  workspaceId: string | null,
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
    const memberIds = workspaceId
      ? new Set((await context.prisma.authWorkspaceMembership.findMany({
          where: { workspaceId, userId: { in: [...userEndpoints.keys()] } },
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
 * Workspace scope: genuine workspace members and the workspace's own service accounts
 * qualify; platform users with support access (but no membership) do not.
 * Platform scope: platform users only.
 */
async function requesterBelongsToScope(
  context: ApiPluginContext,
  auth: RequestAuthContext,
  workspaceId: string | null
): Promise<boolean> {
  if (!workspaceId) {
    return auth.actor.type === 'user' && Boolean(auth.actor.isPlatformUser)
  }
  if (auth.actor.type === 'service-account') {
    return auth.actor.workspace?.id === workspaceId
  }
  if (auth.actor.type === 'user') {
    const membership = await context.prisma.authWorkspaceMembership.findFirst({
      where: { workspaceId, userId: auth.actor.userId },
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
