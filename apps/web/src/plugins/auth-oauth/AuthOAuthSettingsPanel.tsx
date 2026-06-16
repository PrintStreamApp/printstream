import { Alert, Button, Card, CardContent, FormControl, FormLabel, Input, Stack, Textarea, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { extractErrorMessage, type AuthOauthProviderConfig, type AuthBootstrap, type UpdateAuthOauthProviderConfigRequest } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useEffect, useState } from 'react'
import { AuthProviderToggleCard } from '../../components/AuthProviderToggleCard'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, invalidateAuthQueries, platformAuthScopeKey } from '../../lib/authQuery'

function AuthOAuthSettingsForm({
  title,
  description,
  cardVariant,
  authScopeKey = platformAuthScopeKey
}: {
  title: string
  description: string
  cardVariant: 'outlined' | 'soft'
  authScopeKey?: string
}) {
  const queryClient = useQueryClient()
  const configQuery = useQuery({
    queryKey: authQueryKeys.oauthConfig(authScopeKey),
    queryFn: () => apiFetch<AuthOauthProviderConfig>('/api/plugins/auth-oauth/config')
  })
  const [displayName, setDisplayName] = useState('Single Sign-On')
  const [issuerUrl, setIssuerUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [scopesText, setScopesText] = useState('openid\nprofile\nemail')

  useEffect(() => {
    if (!configQuery.data) {
      return
    }
    setDisplayName(configQuery.data.displayName)
    setIssuerUrl(configQuery.data.issuerUrl ?? '')
    setClientId(configQuery.data.clientId ?? '')
    setClientSecret('')
    setScopesText(configQuery.data.scopes.join('\n'))
  }, [configQuery.data])

  const saveMutation = useMutation({
    mutationFn: async (body: UpdateAuthOauthProviderConfigRequest) =>
      apiFetch<AuthOauthProviderConfig>('/api/plugins/auth-oauth/config', {
        method: 'PUT',
        body
      }),
    onSuccess: async () => {
      await invalidateAuthQueries(queryClient, authQueryKeys.oauthConfig(authScopeKey), authQueryKeys.bootstrap)
      setClientSecret('')
    }
  })

  const scopes = Array.from(new Set(scopesText.split(/[,\n\s]+/g).map((value) => value.trim()).filter(Boolean)))
  const requiresSecret = !(configQuery.data?.clientSecretConfigured ?? false)
  const canSave = displayName.trim().length > 0
    && issuerUrl.trim().length > 0
    && clientId.trim().length > 0
    && scopes.length > 0
    && (!requiresSecret || clientSecret.trim().length > 0)

  return (
    <Card variant={cardVariant}>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack spacing={0.5}>
            <Typography level="title-md">{title}</Typography>
            <Typography level="body-sm" textColor="text.tertiary">
              {description}
            </Typography>
          </Stack>

          {configQuery.error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{extractErrorMessage(configQuery.error)}</Alert>
          )}
          {saveMutation.error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{extractErrorMessage(saveMutation.error)}</Alert>
          )}
          {saveMutation.isSuccess && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>Single Sign-On settings saved.</Alert>
          )}

          <FormControl required>
            <FormLabel>Provider label</FormLabel>
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} disabled={configQuery.isLoading || saveMutation.isPending} />
          </FormControl>

          <FormControl required>
            <FormLabel>Issuer URL</FormLabel>
            <Input
              type="url"
              placeholder="https://accounts.example.com/realms/main"
              value={issuerUrl}
              onChange={(event) => setIssuerUrl(event.target.value)}
              disabled={configQuery.isLoading || saveMutation.isPending}
            />
          </FormControl>

          <FormControl required>
            <FormLabel>Client ID</FormLabel>
            <Input value={clientId} onChange={(event) => setClientId(event.target.value)} disabled={configQuery.isLoading || saveMutation.isPending} />
          </FormControl>

          <FormControl required={requiresSecret}>
            <FormLabel>{configQuery.data?.clientSecretConfigured ? 'Client secret (leave blank to keep current value)' : 'Client secret'}</FormLabel>
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              disabled={configQuery.isLoading || saveMutation.isPending}
              placeholder={configQuery.data?.clientSecretConfigured ? 'Stored securely on the server' : undefined}
            />
          </FormControl>

          <FormControl required>
            <FormLabel>Scopes</FormLabel>
            <Textarea
              minRows={3}
              value={scopesText}
              onChange={(event) => setScopesText(event.target.value)}
              disabled={configQuery.isLoading || saveMutation.isPending}
              placeholder="openid\nprofile\nemail"
            />
            <Typography level="body-xs" textColor="text.tertiary">
              Enter one scope per line. The provider must return a verified email address.
            </Typography>
          </FormControl>

          {configQuery.data && (
            <Alert
              color={configQuery.data.configured ? 'success' : 'warning'}
              variant="soft"
              startDecorator={configQuery.data.configured ? <CheckCircleOutlineRoundedIcon /> : <WarningAmberRoundedIcon />}
            >
              {configQuery.data.configured
                ? 'Single Sign-On is configured and available on the sign-in screen when the plugin is enabled.'
                : 'Finish the issuer and client settings to make Single Sign-On available.'}
            </Alert>
          )}

          <Stack direction="row" justifyContent="flex-end">
            <Button
              loading={saveMutation.isPending}
              disabled={!canSave}
              onClick={() => saveMutation.mutate({
                displayName: displayName.trim(),
                issuerUrl: issuerUrl.trim(),
                clientId: clientId.trim(),
                clientSecret: clientSecret.trim() || undefined,
                scopes
              })}
            >
              Save Single Sign-On settings
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}

export function AuthOAuthSettingsPanel() {
  return (
    <AuthOAuthSettingsForm
      title="Single Sign-On"
      description="Configure a generic OpenID Connect provider. Users authenticate by verified email address and are matched against existing auth users."
      cardVariant="outlined"
    />
  )
}

export function AuthOAuthProviderSettingsSection({
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
  const provider = authProviders.find((entry) => entry.id === 'auth-oauth')
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<{ enabled: boolean }>('/api/plugins/auth-oauth/enabled', {
      method: 'POST',
      body: { enabled }
    }),
    onSuccess: async () => await invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.oauthConfig(authScopeKey))
  })

  if (!authBootstrapReady || !canManageAuthProviders || !provider) {
    return null
  }

  return (
    <Stack spacing={1.5}>
      <AuthProviderToggleCard
        title="Single Sign-On"
        description="Enable or disable external identity provider sign-in."
        helperText={provider.enabled
          ? 'Single Sign-On is enabled and uses the configuration shown below.'
          : 'Enable Single Sign-On to configure an OpenID Connect provider.'}
        checked={provider.enabled}
        disabled={toggleMutation.isPending}
        errorMessage={toggleMutation.error ? extractErrorMessage(toggleMutation.error) : null}
        onChange={(enabled) => toggleMutation.mutate(enabled)}
      />

      {provider.enabled && (
        <AuthOAuthSettingsForm
          title={provider.label}
          description="Configure the OpenID Connect provider used for sign-in."
          cardVariant="soft"
          authScopeKey={authScopeKey}
        />
      )}
    </Stack>
  )
}

export function AuthOAuthSetupSection({
  authProviders = [],
  authBootstrapReady = false,
  authScopeKey = platformAuthScopeKey,
  authHost = 'settings',
  canManageAuthProviders = false
}: {
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
  authScopeKey?: string
  authHost?: string
  canManageAuthProviders?: boolean
}) {
  const provider = authProviders.find((entry) => entry.id === 'auth-oauth' && entry.enabled)
  if (!authBootstrapReady || !provider?.capabilities.setup || authHost !== 'auth' || canManageAuthProviders) {
    return null
  }

  return (
    <AuthOAuthSettingsForm
      title={provider.setupRequired ? `${provider.label} setup` : `${provider.label} configuration`}
      description="This provider uses the standard authorization-code + PKCE flow. Configure it here to make SSO available on the sign-in screen."
      cardVariant="soft"
      authScopeKey={authScopeKey}
    />
  )
}