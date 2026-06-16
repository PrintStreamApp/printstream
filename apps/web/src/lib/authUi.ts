import type { AuthActorSummary, AuthUser } from '@printstream/shared'

export type AuthProfileSnapshot = {
  email: string
  displayName: string | null
}

export type ShellIdentity = {
  primary: string
  secondary: string | null
}

export type AuthHealthSignal = {
  id: 'no-enabled-admin' | 'last-enabled-admin' | 'email-code-only-users' | 'disabled-users'
  color: 'danger' | 'warning' | 'neutral'
  title: string
  detail: string
}

export function normalizeAuthProfileDraft(input: { email: string; displayName: string }): AuthProfileSnapshot {
  return {
    email: input.email.trim(),
    displayName: input.displayName.trim() ? input.displayName.trim() : null
  }
}

export function hasAuthProfileChanges(
  current: AuthProfileSnapshot,
  draft: { email: string; displayName: string }
): boolean {
  const normalized = normalizeAuthProfileDraft(draft)
  return normalized.email !== current.email || normalized.displayName !== current.displayName
}

export function canSendAuthUserInvite(input: {
  loginDisabled: boolean
}): boolean {
  return !input.loginDisabled
}

export function deriveAuthHealthSignals(users: AuthUser[], options: { localAuthEnabled?: boolean; adminGroupKey?: string } = {}): AuthHealthSignal[] {
  const localAuthEnabled = options.localAuthEnabled ?? true
  const adminGroupKey = options.adminGroupKey ?? 'admin'
  const adminLabel = 'Admin'
  const enabledAdminUsers = users.filter((user) => !user.loginDisabled && user.groups.some((group) => group.key === adminGroupKey))
  const enabledUsersWithoutPasskeys = users.filter((user) => !user.loginDisabled && user.passkeyCount === 0)
  const disabledUsers = users.filter((user) => user.loginDisabled)
  const signals: AuthHealthSignal[] = []

  if (enabledAdminUsers.length === 0) {
    signals.push({
      id: 'no-enabled-admin',
      color: 'danger',
      title: `No enabled ${adminLabel} users remain`,
      detail: `Re-enable or create an ${adminLabel} user before auth management access is lost.`
    })
  } else if (enabledAdminUsers.length === 1) {
    signals.push({
      id: 'last-enabled-admin',
      color: 'warning',
      title: `Only one enabled ${adminLabel} remains`,
      detail: `Keep a second ${adminLabel} account available so auth recovery does not depend on a single user.`
    })
  }

  if (localAuthEnabled && enabledUsersWithoutPasskeys.length > 0) {
    const hasVerb = enabledUsersWithoutPasskeys.length === 1 ? 'has' : 'have'
    signals.push({
      id: 'email-code-only-users',
      color: 'warning',
      title: `${enabledUsersWithoutPasskeys.length} enabled user${enabledUsersWithoutPasskeys.length === 1 ? '' : 's'} ${hasVerb} no local passkeys`,
      detail: 'For local-auth users, emailed one-time codes remain the only local sign-in and recovery path until a passkey is added.'
    })
  }

  if (disabledUsers.length > 0) {
    const haveVerb = disabledUsers.length === 1 ? 'has' : 'have'
    signals.push({
      id: 'disabled-users',
      color: 'neutral',
      title: `${disabledUsers.length} user${disabledUsers.length === 1 ? '' : 's'} currently ${haveVerb} sign-in disabled`,
      detail: 'Review disabled accounts periodically so temporary lockouts do not become permanent access drift.'
    })
  }

  return signals
}

export function resolveShellIdentity(actor: AuthActorSummary): ShellIdentity | null {
  if (actor.type !== 'user') {
    return null
  }

  const email = actor.email?.trim() || null
  const displayName = actor.displayName?.trim() || null
  const primary = displayName ?? email
  if (!primary) {
    return null
  }

  return {
    primary,
    secondary: displayName && email && displayName !== email ? email : null
  }
}