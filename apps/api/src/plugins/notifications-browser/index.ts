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
 * ## Who may use this
 *
 * Every route here is per-ACTOR, per-DEVICE state: which browser of mine
 * receives this workspace's alerts. So the gate is scope MEMBERSHIP
 * (`requesterBelongsToScope`), not `settings.manage`: a Manager, Operator or
 * Viewer owns a phone too, and gating on the workspace-configuration
 * permission made background notifications an admin-only feature by accident.
 * Shared configuration that genuinely is workspace-wide (message templates,
 * team webhook destinations) keeps its own admin gate elsewhere. The
 * corollary is that a route may not expose anything scope-wide: `GET /`
 * reports the CALLER's device count, and `DELETE /subscriptions` only removes
 * a subscription the caller owns.
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
 *
 * ## Dismissals are cross-scope, on purpose
 *
 * An authenticated dismissal reported by a service worker carries no workspace hint: a
 * service worker has no tab, so `X-PrintStream-Workspace` is absent and the
 * request falls back to the shared workspace-context cookie, which for a
 * platform user or a multi-workspace member reads `platform`, a scope whose
 * subscription list a workspace device can never be in. Scoping the fan-out
 * to the request's workspace therefore matched zero recipients and still
 * answered `202`, which is why dismissal sync silently did nothing. So a
 * dismissal fans out through the shared `notification.dismiss` event by user
 * across every channel and scope. Auth-disabled self-hosted sessions have no
 * person identity, so their dismissals stay local rather than clearing alerts
 * on every unrelated device connected to that server.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Request } from 'express'
import { authUsesExplicitPermissions, type RequestAuthContext } from '../../lib/auth-context.js'
import type { ApiPlugin, ApiPluginContext } from '../../plugin/types.js'
import { annotateRequestAuditLog, skipRequestAuditLog } from '../../lib/audit-logs.js'
import { AUTHENTICATION_REQUIRED_MESSAGE } from '../../lib/authorization.js'
import { badRequest, forbidden, unauthorized, type HttpError } from '../../lib/http-error.js'
import { subscribePrinterNotifications } from '../../lib/notification-format.js'
import { listWorkspaceScopesWithPluginSetting } from '../../lib/notification-scope.js'
import {
  LOCAL_OPERATOR_ACTOR_KEY,
  parseUserActorId,
  serviceAccountActorKey,
  userActorKey,
  userActorKeys
} from './actor-keys.js'
import { WebPushDelivery, type PushSendOptions, type StoredSubscription } from './push.js'
import { deliverTargetedPush } from './targeted-push.js'

/**
 * Transport hints for a retraction, deliberately the opposite trade from a
 * notification. Retained ten minutes rather than one, because the device most
 * likely to still be showing a stale notification is one that slept right
 * after receiving it; `low` urgency so clearing it never spends a sleeping
 * device's radio; and a per-tag collapse topic so swiping away a stack costs
 * an offline device one wake-up instead of one per notification.
 */
const DISMISSAL_TTL_SECONDS = 600

function dismissalSendOptions(key: string): PushSendOptions {
  return {
    ttlSeconds: DISMISSAL_TTL_SECONDS,
    urgency: 'low',
    // Push services cap `Topic` at 32 URL-safe base64 characters, which a
    // notification tag ("printer:<id>:job") neither fits nor is limited to.
    topic: createHash('sha256').update(`dismiss:${key}`).digest('base64url').slice(0, 32)
  }
}

/**
 * How long an enumerated scope list is reused. Swiping away a stack of
 * notifications posts one dismissal each within a second or so, and each
 * would otherwise re-run the cross-workspace `Setting` scan. Short enough
 * that a scope registering its first device is picked up almost at once.
 */
const SUBSCRIPTION_SCOPE_CACHE_MS = 5_000

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
  tag: z.string().min(1).optional(),
  /**
   * The reporting device's own push endpoint, so the fan-out can skip it.
   * Optional: an older service worker does not send one, and the only cost of
   * its absence is one wasted push to a device that has already closed the
   * notification.
   */
  endpoint: z.string().url().optional()
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

    const listSubscriptionWorkspaceScopes = (): Promise<string[]> =>
      listWorkspaceScopesWithPluginSetting(context.prisma, context.pluginName, 'subscriptions')

    /**
     * The same enumeration, briefly cached, for DISMISSALS ONLY.
     *
     * Clearing a stack of notifications posts one dismissal each within a
     * second, and every one is a workspaceless fan-out that re-runs the
     * cross-workspace `Setting` scan. Delivery of a NOTIFICATION must not
     * share this: a scope that registered its first device seconds ago would
     * be missing from a cached list, and the message would silently skip a
     * device nobody can tell was skipped. A retraction can afford that window
     * because the worst case is one notification staying up.
     */
    let cachedScopes: { at: number; scopes: string[] } | null = null
    const listSubscriptionWorkspaceScopesForDismissal = async (): Promise<string[]> => {
      const now = Date.now()
      if (cachedScopes && now - cachedScopes.at < SUBSCRIPTION_SCOPE_CACHE_MS) return cachedScopes.scopes
      const scopes = await listSubscriptionWorkspaceScopes()
      cachedScopes = { at: now, scopes }
      return scopes
    }

    /**
     * Reject anyone who is not a member of the scope they are addressing.
     * Membership is asked FIRST so the auth-disabled install (whose single
     * operator is anonymous) is admitted before the signed-out check; after
     * that, "you are not signed in" must not read as "you are not a member".
     */
    const assertScopeMember = async (request: Request, workspaceId: string | null): Promise<void> => {
      if (await requesterBelongsToScope(context, request.auth, workspaceId)) return
      throw scopeAccessError(request)
    }

    context.router.get('/', async (request, response) => {
      const workspaceId = request.workspace?.id ?? null
      await assertScopeMember(request, workspaceId)
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      response.json({
        publicKey: delivery.getPublicKey(),
        subscriptions: countOwnSubscriptions(workspaceDelivery, request.auth)
      })
    })

    context.router.post('/subscriptions', async (request, response) => {
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
      // Platform users browsing a workspace via support access are not real
      // members, so they must not receive its push notifications. Only genuine
      // workspace members (and the workspace's own service accounts) may
      // register a device. This route cannot just call `assertScopeMember`:
      // when a non-member's browser re-registers an endpoint stored before the
      // guard existed, the stale subscription is dropped first so it
      // self-heals. The refusal itself is the shared one, so a signed-out
      // caller gets the same 401 here as from every sibling route.
      if (!(await requesterBelongsToScope(context, request.auth, workspaceId))) {
        await workspaceDelivery.removeSubscription(parsed.data.subscription.endpoint)
        throw scopeAccessError(request)
      }
      await workspaceDelivery.addSubscription({
        subscription: parsed.data.subscription,
        userAgent: extractUserAgent(request),
        actorKey: buildNotificationActorKey(request.auth)
      })
      response.status(201).json({ subscriptions: countOwnSubscriptions(workspaceDelivery, request.auth) })
    })

    context.router.post('/subscriptions/lookup', async (request, response) => {
      // Read-only status probe (fired on every settings-panel mount); a POST
      // only because the endpoint is a capability URL that must stay out of
      // query strings, no state changes, so no audit row.
      skipRequestAuditLog(request)
      const workspaceId = request.workspace?.id ?? null
      await assertScopeMember(request, workspaceId)
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = endpointBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid lookup payload')
      }
      // Registered TO THE CALLER, not to the scope. Two accounts share a
      // browser profile and therefore one push endpoint: reporting the other
      // account's registration made the panel offer "Disable", which the
      // ownership check on DELETE then refused, stranding the user with no
      // route back to the enrol path.
      const actorKey = buildNotificationActorKey(request.auth)
      const registered = workspaceDelivery.listSubscriptions().some((entry) =>
        entry.endpoint === parsed.data.endpoint && isOwnSubscription(entry, actorKey))
      response.json({ registered })
    })

    context.router.delete('/subscriptions', async (request, response) => {
      const workspaceId = request.workspace?.id ?? null
      annotateRequestAuditLog(request, {
        action: 'unsubscribe-browser-push',
        resource: 'notifications',
        summary: 'Unregistered a browser push notification subscription.'
      })
      await assertScopeMember(request, workspaceId)
      const workspaceDelivery = await getOrCreateScopedDelivery(workspaceId)
      const parsed = endpointBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid unsubscribe payload')
      }
      // Only a subscription the caller owns. A browser only ever unregisters
      // its own endpoint, so this costs nothing in practice, and without it
      // any member holding an endpoint could silence a colleague's device.
      const actorKey = buildNotificationActorKey(request.auth)
      const existing = workspaceDelivery.listSubscriptions()
        .find((entry) => entry.endpoint === parsed.data.endpoint)
      if (existing && !isOwnSubscription(existing, actorKey)) {
        throw forbidden('That subscription belongs to another account.')
      }
      const removed = await workspaceDelivery.removeSubscription(parsed.data.endpoint)
      annotateRequestAuditLog(request, { metadata: { removed } })
      response.json({ removed, subscriptions: countOwnSubscriptions(workspaceDelivery, request.auth) })
    })

    context.router.post('/dismissals', async (request, response) => {
      // Fires once per dismissed notification just to sync the dismissal to
      // the actor's other devices, no durable state changes, so a row per
      // dismissal would only be audit noise.
      skipRequestAuditLog(request)
      const parsed = dismissalBodySchema.safeParse(request.body)
      if (!parsed.success) {
        throw badRequest('Invalid dismissal payload')
      }

      // A device gesture is personal only when authentication gives us a
      // stable user. Anonymous self-hosted devices may be operated by unrelated
      // people, so their dismissal deliberately stays local.
      if (request.auth.actor.type !== 'user') {
        response.status(202).json({ ok: true })
        return
      }

      // Retracting your own notification from your own devices needs no
      // workspace permission. The authenticated user id is the authorization,
      // which is also why no request-workspace membership is checked here.
      const actorKey = buildNotificationActorKey(request.auth)
      if (!actorKey) {
        throw unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
      }

      if (parsed.data.tag) {
        await deliverTargetedPush({
          workspaceId: null,
          payload: {
            type: 'dismiss',
            notificationId: parsed.data.notificationId,
            tag: parsed.data.tag
          },
          targetActorKeys: [actorKey],
          getScopedDelivery: getOrCreateScopedDelivery,
          listSubscriptionWorkspaceScopes: listSubscriptionWorkspaceScopesForDismissal,
          isEnabledForWorkspace: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
          excludeEndpoints: parsed.data.endpoint ? new Set([parsed.data.endpoint]) : undefined,
          sendOptions: dismissalSendOptions(parsed.data.tag)
        })
        context.printerEvents.emit('notification.dismiss', {
          tag: parsed.data.tag,
          notificationId: parsed.data.notificationId,
          workspaceId: null,
          targetUserIds: [request.auth.actor.userId],
          skipBrowser: true
        })
      } else {
        // Older notifications may carry only an id. Native surfaces group by
        // tag, so this fallback stays within browser push.
        await deliverTargetedPush({
          workspaceId: null,
          payload: { type: 'dismiss', notificationId: parsed.data.notificationId },
          targetActorKeys: [actorKey],
          getScopedDelivery: getOrCreateScopedDelivery,
          listSubscriptionWorkspaceScopes: listSubscriptionWorkspaceScopesForDismissal,
          isEnabledForWorkspace: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
          excludeEndpoints: parsed.data.endpoint ? new Set([parsed.data.endpoint]) : undefined,
          sendOptions: dismissalSendOptions(parsed.data.notificationId ?? '')
        })
      }
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
            targetActorKeys: userActorKeys(message.targetUserIds),
            getScopedDelivery: getOrCreateScopedDelivery,
            listSubscriptionWorkspaceScopes,
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
    const handleDismiss = async (event: {
      tag: string
      notificationId?: string
      workspaceId: string | null
      targetUserIds?: string[]
      excludeBrowserEndpoints?: string[]
      skipBrowser?: boolean
    }) => {
      if (event.skipBrowser) return
      const dismissPayload = { type: 'dismiss', tag: event.tag, notificationId: event.notificationId }
      const sendOptions = dismissalSendOptions(event.tag)
      if (event.targetUserIds && event.targetUserIds.length > 0) {
        await deliverTargetedPush({
          workspaceId: event.workspaceId,
          payload: dismissPayload,
          targetActorKeys: userActorKeys(event.targetUserIds),
          getScopedDelivery: getOrCreateScopedDelivery,
          listSubscriptionWorkspaceScopes: listSubscriptionWorkspaceScopesForDismissal,
          isEnabledForWorkspace: (scope) => context.isEnabledForWorkspace?.(scope) ?? true,
          excludeEndpoints: event.excludeBrowserEndpoints ? new Set(event.excludeBrowserEndpoints) : undefined,
          sendOptions
        })
        return
      }
      if (!(context.isEnabledForWorkspace?.(event.workspaceId) ?? true)) return
      const scopedDelivery = await getOrCreateScopedDelivery(event.workspaceId)
      await scopedDelivery.sendToAll(dismissPayload, sendOptions)
    }
    const onDismiss = (event: {
      tag: string
      notificationId?: string
      workspaceId: string | null
      targetUserIds?: string[]
      excludeBrowserEndpoints?: string[]
      skipBrowser?: boolean
    }) => {
      handleDismiss(event).catch((error) => context.logger.warn('web-push dismissal fanout failed', error))
    }
    context.printerEvents.on('notification.dismiss', onDismiss)
    context.onShutdown(() => {
      context.printerEvents.off('notification.dismiss', onDismiss)
    })
  }
}

/**
 * The one refusal for "you may not touch this scope's devices": signed out is
 * 401, a signed-in non-member is 403. Shared so two routes cannot answer the
 * identical request with different status codes.
 */
function scopeAccessError(request: Request): HttpError {
  if (request.auth.actor.type === 'anonymous') {
    return unauthorized(AUTHENTICATION_REQUIRED_MESSAGE)
  }
  return forbidden('Browser notifications are only available to workspace members.')
}

/**
 * Whether a stored subscription belongs to the caller.
 *
 * ONE rule, shared by the count, the lookup and the delete, because they
 * disagreeing is what strands a device: a panel told "registered" by a lookup
 * it may not delete has no way back to the enrol path. Legacy actor-less entries intentionally
 * answer false: their owner cannot be established safely, so the browser must re-enrol the
 * endpoint and attach its current actor key.
 */
function isOwnSubscription(entry: StoredSubscription, actorKey: string | undefined): boolean {
  return entry.actorKey !== undefined && entry.actorKey === actorKey
}

/**
 * How many devices the CALLER has enrolled in this scope. Every route reports
 * this rather than the scope total, which would tell an ordinary member how
 * many devices their colleagues enrolled, for a number only ever used to show
 * the caller their own state.
 */
function countOwnSubscriptions(delivery: WebPushDelivery, auth: RequestAuthContext): number {
  const actorKey = buildNotificationActorKey(auth)
  if (!actorKey) return 0
  return delivery.listSubscriptions().filter((entry) => isOwnSubscription(entry, actorKey)).length
}

/**
 * Resolve the set of subscription endpoints eligible to receive a scope's
 * notifications. Subscriptions tied to a user actor are only deliverable when
 * that user currently belongs to the scope (workspace membership, or the
 * platform-user flag for the platform scope). Service-account subscriptions are always
 * deliverable. Legacy actor-less subscriptions are quarantined until their browser re-enrols,
 * because delivering them could disclose workspace events after their unknown owner was removed.
 */
async function resolveDeliverableEndpoints(
  context: ApiPluginContext,
  workspaceId: string | null,
  subscriptions: readonly StoredSubscription[]
): Promise<Set<string>> {
  const userEndpoints = new Map<string, string[]>()
  const allowed = new Set<string>()
  for (const subscription of subscriptions) {
    if (subscription.actorKey === undefined) continue
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
 *
 * With no auth provider enabled there are no memberships to check and every
 * request is the install's single implicit operator, so a workspace scope
 * admits them. This mirrors `shouldBypassPermissionEnforcement`, including its
 * requirement of a real workspace: that bypass never reached here (this is not
 * a permission check), which is why browser notifications were unusable on an
 * auth-disabled self-hosted install rather than merely admin-only.
 */
async function requesterBelongsToScope(
  context: ApiPluginContext,
  auth: RequestAuthContext,
  workspaceId: string | null
): Promise<boolean> {
  if (!authUsesExplicitPermissions(auth)) {
    return workspaceId !== null
  }
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

/**
 * The key a subscription is stored under and a dismissal fans out by.
 * Encodings live in `actor-keys.ts`; this only decides which one applies.
 */
function buildNotificationActorKey(auth: RequestAuthContext): string | undefined {
  if (auth.actor.type === 'user') {
    return userActorKey(auth.actor.userId)
  }

  if (auth.actor.type === 'service-account') {
    return serviceAccountActorKey(auth.actor.serviceAccountId)
  }

  if (!authUsesExplicitPermissions(auth)) {
    return LOCAL_OPERATOR_ACTOR_KEY
  }

  return undefined
}
