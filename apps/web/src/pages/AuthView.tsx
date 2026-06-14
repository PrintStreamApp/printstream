import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Stack, Typography } from '@mui/joy'
import React from 'react'
import { useLocation } from 'react-router-dom'
import { resolveAuthScope, useAuthBootstrapQuery } from '../lib/authQuery'
import { resolveSettingsAuthState } from '../lib/settingsAuth'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'

/**
 * Core auth shell. Providers contribute their sign-in methods via plugin slots.
 */
export function AuthView({ redirectPath }: { redirectPath?: string } = {}) {
  const location = useLocation()
  const authBootstrapQuery = useAuthBootstrapQuery({ suppressGlobalErrorToast: true })
  const authError = new URLSearchParams(location.search).get('error')
  const authState = authBootstrapQuery.data
    ? resolveSettingsAuthState(authBootstrapQuery.data)
    : null
  const authProviders = authBootstrapQuery.data?.providers ?? []
  const actorType = authBootstrapQuery.data?.actor.type ?? 'anonymous'
  const canManageAuthProviders = authState?.canManageAuthProviders ?? false
  const authEnabled = authBootstrapQuery.data?.authEnabled ?? false
  const authSetupRequired = authBootstrapQuery.data?.setupRequired ?? false
  const hasTenantContext = authBootstrapQuery.data?.tenant != null
  const showsInlineSetup = authSetupRequired && !hasTenantContext
  const showsProviderControls = !hasTenantContext && !authEnabled && canManageAuthProviders && authProviders.length > 0
  const authTitle = showsInlineSetup || showsProviderControls
    ? 'Set up sign in'
    : 'Sign In'
  const enabledSignInProviderCount = authProviders.filter((provider) => provider.enabled && provider.capabilities.signIn).length
  const showsInlineSignInTitle = !showsInlineSetup && !showsProviderControls && enabledSignInProviderCount === 1
  const { authTenantId, authScopeKey } = resolveAuthScope(authBootstrapQuery.data)

  return (
    <Stack
      justifyContent="center"
      sx={{
        minHeight: {
          xs: 'calc(100dvh - var(--app-top-inset, 0px) - 11rem)',
          sm: 'calc(100dvh - var(--app-top-inset, 0px) - 9rem)'
        },
        py: { xs: 2, sm: 4 }
      }}
    >
      <Stack spacing={2} sx={{ width: '100%', maxWidth: 420, mx: 'auto' }}>
        {!showsInlineSignInTitle && <Typography level="h2">{authTitle}</Typography>}
        {authError && (
          <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
            {authError}
          </Alert>
        )}
        {showsProviderControls && (
          <StaticPluginSlot
            name="settings.authenticationProviders"
            context={{
              authProviders,
              authBootstrapReady: authBootstrapQuery.isSuccess,
              authScopeKey,
              canManageAuthProviders
            }}
          />
        )}
        {showsInlineSetup && (
          <StaticPluginSlot
            name="settings.authenticationSetup"
            context={{
              authProviders,
              authSetupRequired,
              authBootstrapReady: authBootstrapQuery.isSuccess,
              authTenantId,
              authScopeKey,
              authHost: 'auth',
              actorType,
              canManageAuthProviders
            }}
          />
        )}
        <StaticPluginSlot
          name="auth.signIn"
          context={{
            authTitle: showsInlineSignInTitle ? authTitle : undefined,
            redirectPath,
            authProviders,
            authSetupRequired,
            authBootstrapReady: authBootstrapQuery.isSuccess,
            authScopeKey
          }}
        />
      </Stack>
    </Stack>
  )
}