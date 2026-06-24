import { Alert, Button, Card, CardContent, Chip, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import {
  type AuthBootstrap,
  type BootstrapPasswordAdminResponse,
  extractErrorMessage,
  PASSWORD_MIN_LENGTH,
  type PasswordAuthStatus
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import {
  authQueryKeys,
  buildAuthBootstrapQueryOptions,
  invalidateAuthQueries,
  platformAuthScopeKey,
  readCurrentAuthBootstrapScopeKey
} from '../../lib/authQuery'
import { resolvePostAuthRedirectPath } from '../../lib/postAuthRedirect'

/** First-run password setup card contributed to the auth and settings shells. */
export function AuthPasswordSetupSection({
  authProviders = [],
  authSetupRequired = false,
  authBootstrapReady = false,
  authScopeKey = platformAuthScopeKey,
  actorType = 'anonymous',
  canManageAuthProviders = false
}: {
  authProviders?: AuthBootstrap['providers']
  authSetupRequired?: boolean
  authBootstrapReady?: boolean
  authTenantId?: string
  authScopeKey?: string
  actorType?: string
  canManageAuthProviders?: boolean
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const passwordEnabled = authProviders.some((provider) => provider.id === 'auth-password' && provider.enabled)
  const showsAuthSetup = authSetupRequired && passwordEnabled

  const statusQuery = useQuery({
    queryKey: authQueryKeys.passwordStatus(authScopeKey),
    queryFn: () => apiFetch<PasswordAuthStatus>('/api/plugins/auth-password/status'),
    enabled: authBootstrapReady && passwordEnabled
  })

  const bootstrapMutation = useMutation({
    mutationFn: (input: { email: string; displayName: string | null; password: string }) =>
      apiFetch<BootstrapPasswordAdminResponse>('/api/plugins/auth-password/bootstrap/admin', {
        method: 'POST',
        body: input
      }),
    onSuccess: async (data) => {
      setPassword('')
      setConfirmPassword('')
      await invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.passwordStatus(authScopeKey))
      // The bootstrap signs the new admin in. When an anonymous visitor created
      // the account, move them into the app; an already-signed-in admin stays put.
      if (data.authenticated && actorType !== 'user') {
        const bootstrap = await queryClient.fetchQuery(buildAuthBootstrapQueryOptions(readCurrentAuthBootstrapScopeKey()))
        navigate(resolvePostAuthRedirectPath(bootstrap, undefined), { replace: true })
      }
    }
  })

  if (!showsAuthSetup || !canManageAuthProviders) {
    return null
  }

  const status = statusQuery.data
  const canCreateInitialAdmin = (status?.counts.users ?? 0) === 0
  const passwordsMatch = password === confirmPassword
  const passwordLongEnough = password.length >= PASSWORD_MIN_LENGTH
  const canSubmit = Boolean(email.trim()) && passwordLongEnough && passwordsMatch && !bootstrapMutation.isPending
  const error = bootstrapMutation.error ? extractErrorMessage(bootstrapMutation.error) : null
  const statusError = statusQuery.error ? extractErrorMessage(statusQuery.error) : null

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Typography level="body-sm" textColor="text.tertiary">
            Set up sign-in by creating the first admin account with an email and password.
          </Typography>

          {statusQuery.isLoading && (
            <Typography level="body-sm" textColor="text.tertiary">
              Loading setup status…
            </Typography>
          )}

          {statusError && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {statusError}
            </Alert>
          )}

          {status && !canCreateInitialAdmin && (
            <Alert color="warning" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
              The initial admin account already exists. Sign in with that account to continue.
            </Alert>
          )}

          {status && canCreateInitialAdmin && (
            <Stack
              component="form"
              spacing={1.25}
              onSubmit={(event) => {
                event.preventDefault()
                if (!canSubmit) return
                bootstrapMutation.mutate({
                  email: email.trim(),
                  displayName: displayName.trim() ? displayName.trim() : null,
                  password
                })
              }}
            >
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <Chip size="sm" variant="soft" color="warning">
                  {status.counts.users} user{status.counts.users === 1 ? '' : 's'}
                </Chip>
              </Stack>

              <FormControl required>
                <FormLabel>Email</FormLabel>
                <Input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="admin@example.com"
                />
              </FormControl>

              <FormControl>
                <FormLabel>Display name</FormLabel>
                <Input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Primary admin"
                />
              </FormControl>

              <FormControl required error={password.length > 0 && !passwordLongEnough}>
                <FormLabel>Password</FormLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <FormHelperText>Use at least {PASSWORD_MIN_LENGTH} characters.</FormHelperText>
              </FormControl>

              <FormControl required error={confirmPassword.length > 0 && !passwordsMatch}>
                <FormLabel>Confirm password</FormLabel>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
                {confirmPassword.length > 0 && !passwordsMatch && (
                  <FormHelperText>Passwords do not match.</FormHelperText>
                )}
              </FormControl>

              {error && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {error}
                </Alert>
              )}

              <Stack direction="row" justifyContent="flex-end" spacing={1}>
                <Button type="submit" loading={bootstrapMutation.isPending} disabled={!canSubmit}>
                  Create initial admin
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
