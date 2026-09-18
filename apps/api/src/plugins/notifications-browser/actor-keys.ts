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
 * With no auth provider enabled there is no user id to key on. The key keeps
 * anonymous workspace broadcasts deliverable without pretending every device
 * connected to that server belongs to one person. User-gesture dismissals are
 * therefore never targeted at this key.
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
