/**
 * Central visibility scope for workspace queries.
 *
 * A deleted workspace keeps its rows so a platform admin can restore it, which
 * means the rows are still there to be found — and a soft delete that leaks into
 * a listing is worse than no soft delete at all, because the workspace reads as
 * gone while remaining reachable. The exclusion therefore lives here rather than
 * being remembered at each of the two dozen places that query workspaces.
 *
 * **Three call sites deliberately do NOT use this**, and they are the reason it
 * is a helper rather than a Prisma middleware:
 * - the retention sweep, which exists to find exactly these rows;
 * - the platform admin listing, which shows them so they can be restored;
 * - restore itself, which has to load one to clear its `deletedAt`.
 *
 * Anything else — auth bootstrap, the workspace chooser, billing, people,
 * support access, plugin fan-out, stats — must not see them. A user whose only
 * workspace was deleted should land where a user with no workspace lands, not
 * in a workspace that no longer exists.
 */

/**
 * Merge a query's `where` with the visible-workspace scope. Spread order pins
 * the field even if the caller's clause tries to set it, so a call site cannot
 * widen the scope by accident.
 */
export function visibleWorkspacesWhere<T extends object>(where: T): T & { deletedAt: null } {
  return { ...where, deletedAt: null }
}

/** The scope on its own, for queries that have no other conditions. */
export const visibleWorkspaceScope = { deletedAt: null } as const

/**
 * How long a deleted workspace stays restorable before the sweep removes it for
 * good.
 *
 * 30 days, matching the library recycle bin (`LIBRARY_RECYCLE_RETENTION_DAYS`)
 * rather than inventing a second number for the same idea: both are "you can
 * still change your mind", and a user who has learned one should not have to
 * learn the other.
 */
export const WORKSPACE_DELETED_RETENTION_DAYS = 30
