/**
 * The actor key a push subscription is stored under.
 *
 * This is a PERSISTED wire format: keys live inside the `subscriptions` JSON
 * in each scope's plugin setting, so a divergence between the code that writes
 * one and the code that matches one silently stops every targeted push and
 * every dismissal for the affected actor, with nothing thrown and nothing
 * logged. It is owned here rather than spelled at each site for exactly that
 * reason. Changing an encoding orphans every stored subscription using it;
 * the recovery is re-enrolling the device, so treat it as a migration.
 */

const USER_PREFIX = 'user:'
const SERVICE_ACCOUNT_PREFIX = 'service-account:'

/**
 * The auth-disabled install's single implicit operator.
 *
 * With no auth provider enabled there is no user id to key on, but the devices
 * still need to reach each other's dismissals: an actor-less subscription
 * matches no targeted delivery at all. It cannot collide with a real actor,
 * and if auth is later enabled these entries simply stop matching, which
 * re-enabling notifications on the device repairs.
 */
export const LOCAL_OPERATOR_ACTOR_KEY = 'local:operator'

export function userActorKey(userId: string): string {
  return `${USER_PREFIX}${userId}`
}

export function serviceAccountActorKey(serviceAccountId: string): string {
  return `${SERVICE_ACCOUNT_PREFIX}${serviceAccountId}`
}

/** Actor keys for a set of user ids, for user-targeted fan-out. */
export function userActorKeys(userIds: readonly string[]): string[] {
  return userIds.map(userActorKey)
}

/** The user id a key names, or null for any other actor type. */
export function parseUserActorId(actorKey: string | undefined): string | null {
  if (!actorKey || !actorKey.startsWith(USER_PREFIX)) return null
  const userId = actorKey.slice(USER_PREFIX.length)
  return userId.length > 0 ? userId : null
}
