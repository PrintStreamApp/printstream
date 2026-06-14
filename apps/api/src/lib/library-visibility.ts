/**
 * Central visibility scope for library file queries.
 *
 * Two kinds of rows must never surface in listings, browse, name matching, or
 * overwrite resolution:
 * - `hidden` rows: transient artifacts — "print from local file" uploads,
 *   unsaved sliced outputs, print-history snapshots, editor new-project
 *   scaffolds. They stay reachable BY ID (re-dispatch, history reprints, the
 *   editor).
 * - `deletedAt` rows: soft-deleted files sitting in the recycle bin until
 *   restored or hard-deleted by the cleanup task.
 *
 * Any `libraryFile` query that selects by something other than an explicit id
 * should build its `where` through `visibleLibraryFilesWhere()` so the
 * exclusion is structural rather than remembered at each call site.
 */

/**
 * Merge a query's `where` with the visible-files scope. Spread order pins the
 * visibility fields even if the caller's clause tries to set them.
 */
export function visibleLibraryFilesWhere<T extends object>(where: T): T & { hidden: false; deletedAt: null } {
  return { ...where, hidden: false, deletedAt: null }
}
