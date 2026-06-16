import { type AuthBootstrap } from '@printstream/shared'

/**
 * Auth-section visibility and access rules for the Settings page.
 *
 * While auth is disabled, the setup/provider flow can stay visible, but user
 * and role management must remain hidden even if auth-disabled route guards
 * report broad capabilities.
 */
export function resolveSettingsAuthState(input: Pick<AuthBootstrap, 'authEnabled' | 'capabilities' | 'providers' | 'setupRequired'>) {
  const authProviders = input.providers ?? []
  const hasEnabledAuthProvider = authProviders.some((provider) => provider.enabled)
  const showsAuthSetup = Boolean(input.setupRequired && authProviders.length > 0)
  const canViewAuth = input.authEnabled && input.capabilities.canViewAuth
  const canManageAuthProviders = showsAuthSetup || input.capabilities.canManageAuthProviders
  const showsAuthenticationSection = authProviders.length > 0 && (showsAuthSetup || canViewAuth || canManageAuthProviders)

  return {
    authProviders,
    hasEnabledAuthProvider,
    showsAuthSetup,
    canViewAuth,
    canManageAuthProviders,
    showsAuthenticationSection
  }
}