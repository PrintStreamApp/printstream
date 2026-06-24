import { extractErrorMessage, type AuthBootstrap } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { AuthProviderToggleCard } from '../../components/AuthProviderToggleCard'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, invalidateAuthQueries, platformAuthScopeKey } from '../../lib/authQuery'

/** Workspace-scoped Password provider toggle shown in auth settings. */
export function AuthPasswordProviderSettingsSection({
  authProviders = [],
  authBootstrapReady = false,
  authScopeKey = platformAuthScopeKey,
  canManageAuthProviders = false
}: {
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
  authScopeKey?: string
  canManageAuthProviders?: boolean
}) {
  const queryClient = useQueryClient()
  const provider = authProviders.find((entry) => entry.id === 'auth-password')
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<{ enabled: boolean }>('/api/plugins/auth-password/enabled', {
      method: 'POST',
      body: { enabled }
    }),
    onSuccess: async () => await invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.passwordStatus(authScopeKey))
  })

  if (!authBootstrapReady || !canManageAuthProviders || !provider) {
    return null
  }

  return (
    <AuthProviderToggleCard
      title="Password"
      description="Enable email and password sign-in."
      helperText={provider.enabled
        ? 'Password sign-in is enabled. Initial admin setup and sign-in are ready here.'
        : 'Enable password sign-in before creating the first admin or allowing sign-in.'}
      checked={provider.enabled}
      disabled={toggleMutation.isPending}
      errorMessage={toggleMutation.error ? extractErrorMessage(toggleMutation.error) : null}
      onChange={(enabled) => toggleMutation.mutate(enabled)}
    />
  )
}
