/**
 * Core's seam for "may this workspace bring someone NEW into the organisation?"
 *
 * Adding people to a workspace is core (`POST /api/auth/users`), but the
 * organisation that governs it is cloud-only and lives under `src/private`,
 * which core must never import. So core asks through this registry, the cloud
 * module answers from the account's policy, and a public build registers
 * nothing and permits everything — an OSS install has no organisation to be
 * restricted by.
 *
 * **Why the policy cannot be a workspace permission.** A workspace admin holds
 * `auth.roles.edit`, so any permission an owner strips from a workspace role
 * that admin can grant straight back to themselves. A restriction on workspace
 * admins has to sit above workspace roles, which is why this asks the ACCOUNT
 * rather than the request's permissions.
 *
 * Counterpart: `apps/api/src/private/cloud/customer.ts` registers the
 * resolver; `apps/api/src/routes/auth-management.ts` asks before adding someone
 * the organisation has never seen.
 */
import { forbidden } from './http-error.js'

export type WorkspaceInvitePolicyResolver = (workspaceId: string) => Promise<boolean>

/** Tells core whether an email already belongs to the workspace's organisation. */
export type OrganisationMemberCheck = (workspaceId: string, email: string) => Promise<boolean>

/** Puts a user into the workspace's organisation, if it has one. */
export type OrganisationJoin = (workspaceId: string, userId: string) => Promise<void>

/** Someone in the workspace's organisation who is not in the workspace yet. */
export interface OrganisationCandidate {
  userId: string
  email: string
  displayName: string | null
}

/** Lists who could be added to this workspace without introducing anyone new. */
export type OrganisationCandidateLister = (workspaceId: string) => Promise<OrganisationCandidate[]>

let resolver: WorkspaceInvitePolicyResolver | null = null
let memberCheck: OrganisationMemberCheck | null = null
let join: OrganisationJoin | null = null
let candidateLister: OrganisationCandidateLister | null = null

/** Called once during cloud module registration. */
export function registerWorkspaceInvitePolicy(
  next: WorkspaceInvitePolicyResolver | null,
  nextMemberCheck: OrganisationMemberCheck | null = null,
  nextJoin: OrganisationJoin | null = null,
  nextCandidateLister: OrganisationCandidateLister | null = null
): void {
  resolver = next
  memberCheck = nextMemberCheck
  join = nextJoin
  candidateLister = nextCandidateLister
}

/**
 * People already in this workspace's organisation who are not in the workspace.
 *
 * Empty in a public build, which has no organisations — the picker simply does
 * not appear and adding by email works as it always has.
 */
export async function listOrganisationCandidates(
  workspaceId: string | null | undefined
): Promise<OrganisationCandidate[]> {
  if (!candidateLister || !workspaceId) return []
  return await candidateLister(workspaceId)
}

/**
 * Make a workspace member a member of that workspace's organisation.
 *
 * The invariant is one-directional: being in a workspace puts you in its
 * organisation, but being in the organisation puts you in no workspace. Applied
 * on write so the two can never disagree — a reconciliation pass would leave a
 * window where the People list is missing someone who already has access.
 *
 * Best-effort on purpose, unlike the invite policy: this RECORDS a consequence
 * of an add that has already happened, so failing it would roll back a
 * successful membership over a bookkeeping row. A missed row shows up as
 * someone absent from the People list, which the next add repairs.
 */
export async function joinWorkspaceOrganisation(
  workspaceId: string | null | undefined,
  userId: string
): Promise<void> {
  if (!join || !workspaceId) return
  try {
    await join(workspaceId, userId)
  } catch (error) {
    console.warn('[auth] could not record organisation membership', { workspaceId, userId, error })
  }
}

/**
 * Whether this workspace may introduce a person who has no account yet, or who
 * is outside its organisation.
 *
 * Permits when there is NO POLICY to apply — no resolver registered (a public
 * build has no organisations) or no workspace in context. That is an absence,
 * not a failure, and the two must not be conflated.
 *
 * A resolver that THROWS is a failure and propagates. Swallowing it would turn
 * "could not check the owner's restriction" into "the owner has no
 * restriction", silently ignoring the setting at exactly the moment it cannot
 * be verified. Denying instead would be worse still: the refusal names a reason
 * ("only the owner can add someone new") that may not be true. Propagating
 * fails the request, creates nobody, and the caller retries.
 */
export async function workspaceMayInviteNewPeople(workspaceId: string | null | undefined): Promise<boolean> {
  if (!resolver || !workspaceId) return true
  return await resolver(workspaceId)
}

/**
 * Refuse only the act the owner actually restricted: introducing someone the
 * organisation has never seen.
 *
 * Adding an existing organisation member to a workspace stays available to
 * anyone holding the workspace permission, so turning the policy off narrows
 * what admins can do without stopping them running their team.
 *
 * Throws rather than guessing if either lookup fails — see
 * `workspaceMayInviteNewPeople`.
 */
export async function assertWorkspaceMayAddPerson(
  workspaceId: string | null | undefined,
  email: string
): Promise<void> {
  if (!workspaceId || !memberCheck) return
  if (await workspaceMayInviteNewPeople(workspaceId)) return
  // Also propagates: "cannot tell whether they are already in the organisation"
  // is not "they are".
  if (await memberCheck(workspaceId, email)) return
  throw forbidden(
    'Only the account owner can add someone new. You can add people who are already in this organisation.'
  )
}
