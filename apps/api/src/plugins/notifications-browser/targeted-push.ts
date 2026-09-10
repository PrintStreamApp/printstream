/**
 * Actor-targeted Web Push fan-out.
 *
 * Broadcast notifications go to every subscription in the event's scope; a
 * targeted payload (a message with `targetUserIds`, or a dismissal retracting
 * one) instead goes only to the target actors' devices (matched by the
 * subscription's `actorKey`, `user:<id>` or `service-account:<id>`):
 *
 * - With a `workspaceId`, delivery stays inside that workspace's list and the
 *   caller-supplied deliverability filter (membership) still applies.
 * - Without one (platform-wide personal events, e.g. a reply to your
 *   suggestion, or ANY dismissal), delivery spans the platform scope plus
 *   every workspace scope that holds subscriptions; a user's device endpoint
 *   appears once per workspace they enabled, so fan-out dedupes by endpoint.
 *
 * Matching on the actor key rather than a user id is deliberate: a
 * subscription stores the key, and a dismissal's actor is whoever the session
 * belongs to, which is not always a user.
 */
import type { PushSendOptions, StoredSubscription } from './push.js'

/** The slice of `WebPushDelivery` the targeted fan-out needs. */
export interface TargetedPushScopeDelivery {
  sendMatching(
    payload: unknown,
    predicate: (entry: StoredSubscription) => boolean,
    options?: PushSendOptions
  ): Promise<void>
}

export interface TargetedPushOptions {
  /** Scope the event originated from (`null` = platform/workspaceless). */
  workspaceId: string | null
  /** JSON payload each matched subscription receives. */
  payload: unknown
  /** Subscription actor keys to deliver to (`user:<id>` / `service-account:<id>`). */
  targetActorKeys: readonly string[]
  /** Scoped delivery accessor (`null` = platform scope). */
  getScopedDelivery: (workspaceId: string | null) => Promise<TargetedPushScopeDelivery>
  /** Workspace scopes that currently hold subscription lists. */
  listSubscriptionWorkspaceScopes: () => Promise<string[]>
  /** Plugin enablement per scope; disabled scopes are skipped. */
  isEnabledForWorkspace: (workspaceId: string | null) => boolean
  /**
   * Extra deliverability filter applied on top of the actor match for
   * workspace-scoped messages (membership checks). Cross-scope personal
   * delivery skips it: being addressed by actor key IS the authorization,
   * and the device belongs to that actor wherever it registered.
   */
  isDeliverableInScope?: (entry: StoredSubscription) => boolean
  /**
   * Endpoints to skip. Used by a dismissal to avoid echoing back to the
   * device that reported it: that notification is already closed there, and
   * a push showing nothing spends the `userVisibleOnly` budget for nothing.
   */
  excludeEndpoints?: ReadonlySet<string>
  /** Transport hints (TTL, urgency, collapse topic) for every send. */
  sendOptions?: PushSendOptions
}

export async function deliverTargetedPush(options: TargetedPushOptions): Promise<void> {
  const targetActorKeys = new Set(options.targetActorKeys)
  if (targetActorKeys.size === 0) return

  const scopes: Array<string | null> = options.workspaceId
    ? [options.workspaceId]
    : [null, ...await options.listSubscriptionWorkspaceScopes()]

  // Resolve every scope's delivery CONCURRENTLY: each one is a cold `Setting`
  // read the first time a scope is touched, and a workspaceless fan-out (every
  // dismissal) visits them all, so doing this in the send loop cost one
  // round-trip per workspace on the node before the first push went out.
  const deliveries = await Promise.all(
    scopes.map(async (workspaceId) => (
      options.isEnabledForWorkspace(workspaceId) ? await options.getScopedDelivery(workspaceId) : null
    ))
  )

  // The send loop stays SEQUENTIAL: `deliveredEndpoints` decides which scope
  // owns a device registered in several, and racing the scopes would make that
  // choice arbitrary. Sends within a scope are already parallel.
  const deliveredEndpoints = new Set<string>()
  for (const delivery of deliveries) {
    if (!delivery) continue
    await delivery.sendMatching(options.payload, (entry) => {
      if (!entry.actorKey || !targetActorKeys.has(entry.actorKey)) return false
      if (options.excludeEndpoints?.has(entry.endpoint)) return false
      if (options.workspaceId && options.isDeliverableInScope && !options.isDeliverableInScope(entry)) {
        return false
      }
      if (deliveredEndpoints.has(entry.endpoint)) return false
      deliveredEndpoints.add(entry.endpoint)
      return true
    }, options.sendOptions)
  }
}
