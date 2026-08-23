/**
 * User-targeted Web Push fan-out.
 *
 * Broadcast notifications go to every subscription in the event's scope; a
 * targeted payload (a message with `targetUserIds`, or a dismissal retracting
 * one) instead goes only to the target users' devices (matched by the
 * subscription's `user:<id>` actor key):
 *
 * - With a `workspaceId`, delivery stays inside that workspace's list and the
 *   caller-supplied deliverability filter (membership) still applies.
 * - Without one (platform-wide personal events, e.g. a reply to your
 *   suggestion), delivery spans the platform scope plus every workspace scope
 *   that holds subscriptions, a user's device endpoint appears once per
 *   workspace they enabled, so fan-out dedupes by endpoint.
 */
import type { StoredSubscription } from './push.js'

/** The slice of `WebPushDelivery` the targeted fan-out needs. */
export interface TargetedPushScopeDelivery {
  sendMatching(payload: unknown, predicate: (entry: StoredSubscription) => boolean): Promise<void>
}

export interface TargetedPushOptions {
  /** Scope the event originated from (`null` = platform/workspaceless). */
  workspaceId: string | null
  /** JSON payload each matched subscription receives. */
  payload: unknown
  targetUserIds: readonly string[]
  /** Scoped delivery accessor (`null` = platform scope). */
  getScopedDelivery: (workspaceId: string | null) => Promise<TargetedPushScopeDelivery>
  /** Workspace scopes that currently hold subscription lists. */
  listSubscriptionWorkspaceScopes: () => Promise<string[]>
  /** Plugin enablement per scope; disabled scopes are skipped. */
  isEnabledForWorkspace: (workspaceId: string | null) => boolean
  /**
   * Extra deliverability filter applied on top of the actor match for
   * workspace-scoped messages (membership checks). Cross-scope personal
   * delivery skips it: being addressed by user id IS the authorization,
   * and the device belongs to that user wherever it registered.
   */
  isDeliverableInScope?: (entry: StoredSubscription) => boolean
}

export async function deliverTargetedPush(options: TargetedPushOptions): Promise<void> {
  const targetActorKeys = new Set(options.targetUserIds.map((userId) => `user:${userId}`))
  if (targetActorKeys.size === 0) return

  const scopes: Array<string | null> = options.workspaceId
    ? [options.workspaceId]
    : [null, ...await options.listSubscriptionWorkspaceScopes()]

  const deliveredEndpoints = new Set<string>()
  for (const workspaceId of scopes) {
    if (!options.isEnabledForWorkspace(workspaceId)) continue
    const delivery = await options.getScopedDelivery(workspaceId)
    await delivery.sendMatching(options.payload, (entry) => {
      if (!entry.actorKey || !targetActorKeys.has(entry.actorKey)) return false
      if (options.workspaceId && options.isDeliverableInScope && !options.isDeliverableInScope(entry)) {
        return false
      }
      if (deliveredEndpoints.has(entry.endpoint)) return false
      deliveredEndpoints.add(entry.endpoint)
      return true
    })
  }
}
