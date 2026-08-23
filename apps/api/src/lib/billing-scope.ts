/**
 * Core's seam for the billing scopes a user may switch into.
 *
 * The workspace switcher is CORE, it renders workspaces, the platform scope,
 * and now billing, but billing itself is cloud-only and lives under
 * `src/private`, which core must never import. So core exposes this registry,
 * the cloud module fills it at startup, and a public build leaves it empty and
 * behaves exactly as it did before billing scopes existed.
 *
 * Same shape as auth-provider registration, for the same reason: it is the only
 * way for a stripped-out module to contribute to a core response.
 *
 * Counterpart: `apps/api/src/private/cloud/customer.ts` registers the
 * resolver; `apps/api/src/routes/auth.ts` reads it.
 */
import type { CustomerSummary } from '@printstream/shared'

export type CustomerResolver = (userId: string) => Promise<CustomerSummary[]>

/**
 * Whether this user belongs to an account at all -- deliberately broader than
 * `CustomerResolver`, which answers the narrower "may they see the money".
 */
export type AccountMembershipResolver = (userId: string) => Promise<boolean>

let resolver: CustomerResolver | null = null
let accountMembershipResolver: AccountMembershipResolver | null = null

/**
 * Called once during cloud module registration. Replacing an existing resolver
 * is allowed and is what test harnesses do; there is only ever one cloud module.
 */
export function registerCustomerResolver(next: CustomerResolver | null): void {
  resolver = next
}

/** Registered alongside `registerCustomerResolver`, by the same module. */
export function registerAccountMembershipResolver(next: AccountMembershipResolver | null): void {
  accountMembershipResolver = next
}

/**
 * Whether this user is somebody here without being in a workspace.
 *
 * Sign-in asks it. Local auth is enabled PER WORKSPACE, so a user's ability to
 * sign in was derived entirely from their memberships -- which silently made an
 * account with no workspace un-signable-into, and registering for a self-hosted
 * licence creates exactly that. A workspace policy cannot speak for someone no
 * workspace contains, so this asks whether the account itself exists.
 *
 * Broader than billing access on purpose: a colleague added to the organisation
 * but not yet to a workspace must be able to sign in and see nothing, rather
 * than be unable to sign in at all.
 *
 * False in a public build (no resolver) and false on error, so the failure mode
 * is the behaviour that predates accounts rather than an open door.
 */
export async function userHasAccountMembership(userId: string | null): Promise<boolean> {
  if (!accountMembershipResolver || !userId) return false
  try {
    return await accountMembershipResolver(userId)
  } catch (error) {
    console.warn('[billing] could not resolve account membership', { userId, error })
    return false
  }
}

/**
 * The billing scopes this user may reach, or none.
 *
 * Empty is the ordinary answer, not a failure: it covers a public build, an
 * anonymous visitor, and every signed-in user who has not been granted billing
 * access. A resolver that throws is treated as none rather than failing the
 * whole auth bootstrap: the switcher losing an entry is recoverable, a shell
 * that cannot start is not.
 */
export async function listCustomersForUser(userId: string | null): Promise<CustomerSummary[]> {
  if (!resolver || !userId) return []
  try {
    return await resolver(userId)
  } catch (error) {
    console.warn('[billing] could not resolve billing scopes for the switcher', { userId, error })
    return []
  }
}
