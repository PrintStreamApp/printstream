/**
 * Pure decision helpers for auth/setup route chrome — the single owner of the
 * "should this route show the loading splash, the auth wall, or the real page"
 * logic, plus the platform-vs-tenant auth-theme and account-tab heuristics. Kept
 * as pure functions (no hooks) so route components and tests share one source of
 * truth instead of re-deriving the state machine. See the web development notes.
 */
import type { AuthActorSummary } from '@printstream/shared'

export type AuthRouteState = 'loading' | 'auth' | 'redirect'
export type ProtectedRouteState = 'loading' | 'auth' | 'render'
export type PublicRootRouteState = 'marketing'

export function shouldShowAccountTab(input: {
  authBootstrapReady: boolean
  actorType: AuthActorSummary['type']
  activeTenantId?: string | null
  memberTenantIds?: ReadonlySet<string>
}): boolean {
  if (!input.authBootstrapReady) {
    return false
  }

  if (input.actorType !== 'user') {
    return false
  }

  if (input.activeTenantId == null) {
    return true
  }

  return input.memberTenantIds?.has(input.activeTenantId) ?? false
}

export function resolveAuthRouteState(input: {
  authBootstrapReady: boolean
  authEnabled: boolean
  authSetupRequired: boolean
  authProviderSetupAvailable?: boolean
  allowSetup?: boolean
  isAuthenticated: boolean
}): AuthRouteState {
  if (!input.authBootstrapReady) {
    return 'loading'
  }

  if ((input.authSetupRequired || input.authProviderSetupAvailable) && (input.allowSetup ?? true)) {
    return 'auth'
  }

  return input.authEnabled && !input.isAuthenticated ? 'auth' : 'redirect'
}

export function resolveProtectedRouteState(input: {
  authBootstrapReady: boolean
  authEnabled: boolean
  authSetupRequired: boolean
  authProviderSetupAvailable?: boolean
  allowSetup?: boolean
  isAuthenticated: boolean
}): ProtectedRouteState {
  const authRouteState = resolveAuthRouteState(input)
  if (authRouteState === 'loading') {
    return 'loading'
  }

  return authRouteState === 'auth' ? 'auth' : 'render'
}

/**
 * The public root (`/`) always renders marketing today. The inputs are kept in
 * the signature (and ignored) so callers keep passing the auth/route state and a
 * future rule — e.g. redirecting an authenticated user straight into the app —
 * can be added here without changing every call site.
 */
export function resolvePublicRootRouteState(input: {
  isAuthenticated: boolean
  defaultRouteReady: boolean
}): PublicRootRouteState {
  void input
  return 'marketing'
}

export function shouldUsePlatformAuthTheme(input: {
  hasTenantContext: boolean
  canUsePlatformWorkspace: boolean
  authRouteState: AuthRouteState
}): boolean {
  if (input.canUsePlatformWorkspace && !input.hasTenantContext) {
    return true
  }

  return input.authRouteState === 'auth' && !input.hasTenantContext
}

export function shouldShowWorkspaceSwitcher(input: {
  authRouteState: AuthRouteState
  requestedTenantSlug?: string | null
  activeTenantSlug?: string | null
}): boolean {
  return input.authRouteState === 'redirect'
}