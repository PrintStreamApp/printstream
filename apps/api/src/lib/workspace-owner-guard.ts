/**
 * Who cannot be removed, demoted, or locked out of a workspace.
 *
 * Core owns the QUESTION and the enforcement; a deployment surface owns the
 * answer. On the multi-workspace cloud that answer is "the person who owns the
 * billing account this workspace belongs to", they pay for it, so a workspace
 * admin must not be able to lock them out of the thing they are being billed
 * for. Nothing fills this on a self-hosted install, where there is no account
 * above the workspace and every admin is already the top of the hierarchy.
 *
 * A registry rather than a direct call because the cloud module lives under
 * `src/private/` and core must never import it, the same shape as
 * `printer-quota.ts` and `billing-scope.ts`.
 *
 * **This is a floor, not a ceiling.** It never grants anything: the owner still
 * has to hold a role to use the workspace. It only refuses the specific changes
 * that would strand them, and it is checked alongside `assertAdminLockoutNotTriggered`
 * rather than instead of it: the two protect different people for different
 * reasons and either can be the one that fires.
 */

/**
 * Answers whether a user is protected in a workspace, and why.
 *
 * The reason is shown to the admin who tried, so it must say who is protected
 * and by what: "you cannot remove this user" with no explanation reads as a
 * bug in the People page.
 */
export type ProtectedWorkspaceMemberResolver = (
  workspaceId: string,
  userId: string
) => Promise<string | null>

let resolver: ProtectedWorkspaceMemberResolver | null = null

export function registerProtectedWorkspaceMemberResolver(next: ProtectedWorkspaceMemberResolver): void {
  resolver = next
}

/** Test seam: drops the registration so a case starts from an unguarded workspace. */
export function __resetProtectedWorkspaceMemberResolverForTests(): void {
  resolver = null
}

/**
 * The reason this user may not be stripped of access to this workspace, or null
 * when they may be.
 *
 * Returns null when nothing is registered (self-hosted), so core behaviour is
 * unchanged on the builds that have no account layer.
 */
export async function protectedWorkspaceMemberReason(
  workspaceId: string | null,
  userId: string
): Promise<string | null> {
  if (!workspaceId || !resolver) return null
  try {
    return await resolver(workspaceId, userId)
  } catch (error) {
    // Fail OPEN. A guard that 500s on a transient read would block routine
    // people-management for everyone, to protect a case that arises rarely --
    // and the owner can restore their own access from the account page either
    // way, which is the backstop this guard is only making unnecessary.
    console.warn('[workspace-owner] could not resolve protected membership; allowing the change', { workspaceId, error })
    return null
  }
}
