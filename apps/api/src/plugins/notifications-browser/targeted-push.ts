/**
 * User-targeted Web Push fan-out.
 *
 * Broadcast notifications go to every subscription in the event's scope;
 * a message with `targetUserIds` instead goes only to the target users'
 * devices (matched by the subscription's `user:<id>` actor key):
 *
 * - With a `tenantId`, delivery stays inside that workspace's list and the
 *   caller-supplied deliverability filter (membership) still applies.
 * - Without one (platform-wide personal events, e.g. a reply to your
 *   suggestion), delivery spans the platform scope plus every tenant scope
 *   that holds subscriptions — a user's device endpoint appears once per
 *   workspace they enabled, so fan-out dedupes by endpoint.
 */
import type { NotificationMessage } from '@printstream/shared'
import type { StoredSubscription } from './push.js'

/** The slice of `WebPushDelivery` the targeted fan-out needs. */
export interface TargetedPushScopeDelivery {
  sendMatching(payload: unknown, predicate: (entry: StoredSubscription) => boolean): Promise<void>
}

export interface TargetedPushOptions {
  message: NotificationMessage
  targetUserIds: readonly string[]
  /** Scoped delivery accessor (`null` = platform scope). */
  getScopedDelivery: (tenantId: string | null) => Promise<TargetedPushScopeDelivery>
  /** Tenant scopes that currently hold subscription lists. */
  listSubscriptionTenantScopes: () => Promise<string[]>
  /** Plugin enablement per scope; disabled scopes are skipped. */
  isEnabledForTenant: (tenantId: string | null) => boolean
  /**
   * Extra deliverability filter applied on top of the actor match for
   * tenant-scoped messages (membership checks). Cross-scope personal
   * delivery skips it: being addressed by user id IS the authorization,
   * and the device belongs to that user wherever it registered.
   */
  isDeliverableInScope?: (entry: StoredSubscription) => boolean
}

export async function deliverTargetedPush(options: TargetedPushOptions): Promise<void> {
  const targetActorKeys = new Set(options.targetUserIds.map((userId) => `user:${userId}`))
  if (targetActorKeys.size === 0) return

  const scopes: Array<string | null> = options.message.tenantId
    ? [options.message.tenantId]
    : [null, ...await options.listSubscriptionTenantScopes()]

  const deliveredEndpoints = new Set<string>()
  for (const tenantId of scopes) {
    if (!options.isEnabledForTenant(tenantId)) continue
    const delivery = await options.getScopedDelivery(tenantId)
    await delivery.sendMatching(options.message, (entry) => {
      if (!entry.actorKey || !targetActorKeys.has(entry.actorKey)) return false
      if (options.message.tenantId && options.isDeliverableInScope && !options.isDeliverableInScope(entry)) {
        return false
      }
      if (deliveredEndpoints.has(entry.endpoint)) return false
      deliveredEndpoints.add(entry.endpoint)
      return true
    })
  }
}
