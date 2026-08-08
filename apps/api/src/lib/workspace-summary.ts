/**
 * The shape of a workspace as request-scoped code sees it, and the one select
 * that produces it.
 *
 * A leaf module on purpose. `workspace-context.ts` and `workspace-resolution.ts` import
 * each other at runtime (context resolution falls back to the wide-open default
 * workspace), so anything they BOTH need as a value has to live outside that pair —
 * putting the select on either one turns a previously type-only edge into a real
 * import cycle, and the shared const reads as `undefined` from whichever module
 * happens to evaluate second.
 */

/**
 * Identity of the workspace a request is scoped to.
 *
 * Deliberately narrow: this is what workspace-scoped data access keys off, so it
 * holds identity plus the one presentational fact the browser cannot obtain any
 * other way in the same round trip.
 */
export interface RequestWorkspaceSummary {
  id: string
  slug: string
  name: string
}

/**
 * The columns every request-scoped workspace lookup selects. One const rather than
 * a repeated literal so a new summary field cannot reach some resolution paths
 * (explicit slug, cookie, host, sole-workspace fallback) and not others — which
 * would make behaviour depend on how the workspace happened to be addressed.
 */
export const REQUEST_WORKSPACE_SELECT = {
  id: true,
  slug: true,
  name: true
} as const

/** Narrow a `Workspace` row selected with {@link REQUEST_WORKSPACE_SELECT}. */
export function toRequestWorkspaceSummary(
  row: { id: string; slug: string; name: string }
): RequestWorkspaceSummary {
  return { id: row.id, slug: row.slug, name: row.name }
}
