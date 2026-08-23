/**
 * Core's seam for sending someone a sign-in invite.
 *
 * Inviting is an AUTH PROVIDER's job, only it knows how a person proves who
 * they are, but the places that need to invite are not auth surfaces. The
 * billing scope's People list adds a colleague to the organisation, and that
 * colleague almost never has an account yet; without an invite they are handed a
 * membership they have no way to reach.
 *
 * It cannot simply call the provider's own invite route: that one is gated on a
 * WORKSPACE permission, and the person doing the inviting here holds billing on
 * an ACCOUNT and may administer no workspace at all. Same shape as
 * `billing-scope.ts` and `workspace-invite-policy.ts`: core exposes the
 * registry, the provider fills it at activation, and a deployment with no
 * provider that can invite simply cannot, which callers must treat as ordinary.
 *
 * Counterpart: `apps/api/src/plugins/auth-local/index.ts` registers the sender.
 */

export interface UserInviteRequest {
  userId: string
  email: string
  /** Where the invite link should land them once they are signed in. */
  redirectTo?: string | null
  timeZone?: string | null
  locale?: string | null
}

export type UserInviteSender = (request: UserInviteRequest) => Promise<void>

let sender: UserInviteSender | null = null

/**
 * Called once during provider activation. Replacing an existing sender is
 * allowed and is what test harnesses do.
 */
export function registerUserInviteSender(next: UserInviteSender | null): void {
  sender = next
}

/** Whether anything on this deployment can send an invite at all. */
export function canSendUserInvites(): boolean {
  return sender != null
}

/**
 * Invite someone to sign in, reporting whether an invite actually went out.
 *
 * **Best-effort by contract: never throws, and never fails the operation that
 * asked for it.** The caller has already created a person and their memberships
 * by this point; unwinding that because an SMTP host was briefly unreachable
 * would be worse than a member who has to be re-invited. Callers surface the
 * `false` so the operator knows to try again rather than assuming it arrived.
 */
export async function sendUserSignInInvite(request: UserInviteRequest): Promise<boolean> {
  if (!sender) return false
  try {
    await sender(request)
    return true
  } catch (error) {
    console.warn('[invite] could not send a sign-in invite', { userId: request.userId, error })
    return false
  }
}
