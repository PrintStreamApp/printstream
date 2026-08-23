/**
 * The account-scoped API base, built once.
 *
 * `/api/customers/:id` was assembled by hand in six places (two shells, three
 * panels, a hook), each remembering to `encodeURIComponent` on its own, and it
 * is also the React Query key prefix for everything under an account, so two
 * spellings meant two cache entries for one resource. The People page fetched
 * workspace roles twice for exactly that reason, and one copy could sit an hour
 * stale while the other was fresh.
 *
 * Lives in CORE, not `private/cloud`: `App.tsx` and `MarketingApp.tsx` build
 * this path when auth bootstrap reports an account, and core must never import
 * from a private directory, that directory is deleted in the public build.
 * The path is inert there, because nothing reports an account.
 *
 * Counterpart: `apps/api/src/private/cloud/billing-scope-routes.ts`, mounted at
 * this path.
 */

/** `/api/customers/:id` for an account, or null when there is no account yet. */
export function customerApiBase(customerId: string | null | undefined): string | null {
  if (!customerId) return null
  return `/api/customers/${encodeURIComponent(customerId)}`
}

/**
 * The React Query key prefix for anything under an account.
 *
 * Keyed on the ACCOUNT ID rather than the base path, so a caller holding either
 * one lands on the same cache entry.
 */
export function customerQueryKey(customerId: string, ...rest: ReadonlyArray<string>): ReadonlyArray<string> {
  return ['customer', customerId, ...rest]
}
