import { Button, Card, CardContent, Stack, Typography } from '@mui/joy'
import { type AuthBootstrap, type AuthOauthProviderConfig } from '@printstream/shared'
import { useQuery } from '@tanstack/react-query'
import React from 'react'
import { buildApiUrl } from '../../lib/apiUrl'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, platformAuthScopeKey } from '../../lib/authQuery'

/** OAuth sign-in panel contributed to the core auth screen. */
export function AuthOAuthSignInSection({
  authTitle,
  redirectPath,
  authProviders = [],
  authBootstrapReady = false,
  authScopeKey = platformAuthScopeKey
}: {
  authTitle?: string
  redirectPath?: string
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
  authScopeKey?: string
}) {
  const provider = authProviders.find((entry) => entry.id === 'auth-oauth' && entry.enabled)
  const configQuery = useQuery({
    queryKey: authQueryKeys.oauthConfig(authScopeKey),
    queryFn: () => apiFetch<AuthOauthProviderConfig>('/api/plugins/auth-oauth/config'),
    enabled: authBootstrapReady && Boolean(provider?.enabled && provider.setupRequired),
    meta: { suppressGlobalErrorToast: true }
  })

  const canStartOauth = provider?.setupRequired ? configQuery.data?.configured === true : true

  if (!authBootstrapReady || !provider?.capabilities.signIn || !canStartOauth) {
    return null
  }

  const target = buildApiUrl(`/api/plugins/auth-oauth/authorize${redirectPath && redirectPath !== '/auth' ? `?redirectTo=${encodeURIComponent(redirectPath)}` : ''}`)

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          {authTitle && <Typography level="h2">{authTitle}</Typography>}
          <Typography level="body-sm" textColor="text.tertiary">
            {provider.setupRequired
              ? `Finish ${provider.label} setup by completing the first verified admin sign-in.`
              : `${provider.label} is enabled for this install. Continue with your external identity provider.`}
          </Typography>
          <Stack direction="row" justifyContent="flex-end">
            <Button onClick={() => window.location.assign(target)}>
              Continue with {provider.label}
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}