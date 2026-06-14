import { extractErrorMessage, type AuthBootstrap } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { AuthProviderToggleCard } from '../../components/AuthProviderToggleCard'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, invalidateAuthQueries, platformAuthScopeKey } from '../../lib/authQuery'

/** Workspace-scoped Local Auth toggle shown in platform and tenant auth settings. */
export function AuthLocalProviderSettingsSection({
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
  const provider = authProviders.find((entry) => entry.id === 'auth-local')
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<{ enabled: boolean }>('/api/plugins/auth-local/enabled', {
      method: 'POST',
      body: { enabled }
    }),
    onSuccess: async () => await invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.localStatus(authScopeKey))
  })

  if (!authBootstrapReady || !canManageAuthProviders || !provider) {
    return null
  }

  return (
    <AuthProviderToggleCard
      title="Local Auth"
      description="Enable passkey and email-code sign-in."
      helperText={provider.enabled
        ? 'Local Auth is enabled. Initial admin setup and sign-in are ready here.'
        : 'Enable Local Auth before creating the first admin or allowing local sign-in.'}
      checked={provider.enabled}
      disabled={toggleMutation.isPending}
      errorMessage={toggleMutation.error ? extractErrorMessage(toggleMutation.error) : null}
      onChange={(enabled) => toggleMutation.mutate(enabled)}
    />
  )
}