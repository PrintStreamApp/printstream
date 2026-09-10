/**
 * Whether the tab's current scope accepts personal notification delivery for
 * the signed-in actor.
 *
 * Mirrors the API's scope rule for per-actor, per-device notification routes
 * (`requesterBelongsToScope` in the notifications-browser plugin, and
 * `assertPlatformScopeActor` in notifications-email): a workspace admits its
 * members, while the platform scope admits platform users only.
 *
 * Core owns it because it is the precondition of the `account.notifications`
 * slot, and because both channel plugins need it and a plugin may not import
 * another. Getting it wrong is not cosmetic: browser push asks the BROWSER for
 * notification permission before it calls the API, so offering enrolment to an
 * actor the server refuses spends a permanent permission grant on a control
 * that then fails; email's status read answers 401 and its panel renders that
 * as "no SMTP configured", blaming the install for a permission answer.
 *
 * The case this exists for is ordinary: a multi-workspace account sits at the
 * platform scope until it picks a workspace, so it is signed in, not a
 * platform user, and in no workspace.
 */
import type { AuthBootstrap } from '@printstream/shared'

export function scopeAcceptsPersonalNotifications(
  bootstrap: Pick<AuthBootstrap, 'workspace' | 'actor' | 'memberWorkspaces'> | undefined
): boolean {
  if (!bootstrap) return false
  if (bootstrap.workspace) {
    return bootstrap.memberWorkspaces.some((workspace) => workspace.id === bootstrap.workspace?.id)
  }
  return bootstrap.actor.type === 'user' && bootstrap.actor.isPlatformUser === true
}
