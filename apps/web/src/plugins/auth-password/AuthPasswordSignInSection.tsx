import { Alert, Box, Button, Card, CardContent, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import {
  type AuthBootstrap,
  extractErrorMessage,
  type PasswordResetAvailability,
  type PasswordSignInResponse
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, buildAuthBootstrapQueryOptions, readCurrentAuthBootstrapScopeKey } from '../../lib/authQuery'
import { resolvePostAuthRedirectPath } from '../../lib/postAuthRedirect'
import { AuthPasswordResetFlow } from './AuthPasswordResetFlow'

/** Email/password sign-in panel contributed to the core auth screen. */
export function AuthPasswordSignInSection({
  authTitle,
  redirectPath,
  authProviders = [],
  authBootstrapReady = false,
  authSetupRequired = false
}: {
  authTitle?: string
  redirectPath?: string
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
  authSetupRequired?: boolean
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'sign-in' | 'reset'>('sign-in')
  const passwordEnabled = authProviders.some((provider) => provider.id === 'auth-password' && provider.enabled)

  const resetAvailabilityQuery = useQuery({
    queryKey: ['plugin-settings', 'auth-password', 'reset-availability'],
    queryFn: () => apiFetch<PasswordResetAvailability>('/api/plugins/auth-password/password-reset'),
    enabled: authBootstrapReady && passwordEnabled && !authSetupRequired
  })
  const resetAvailable = Boolean(resetAvailabilityQuery.data?.available)

  async function navigateAfterAuth(redirectTo?: string | null) {
    await queryClient.invalidateQueries({ queryKey: authQueryKeys.bootstrap })
    if (redirectTo && redirectTo !== '/auth') {
      navigate(redirectTo, { replace: true })
      return
    }
    const bootstrap = await queryClient.fetchQuery(buildAuthBootstrapQueryOptions(readCurrentAuthBootstrapScopeKey()))
    navigate(resolvePostAuthRedirectPath(bootstrap, redirectPath), { replace: true })
  }

  const signIn = useMutation({
    mutationFn: async () => apiFetch<PasswordSignInResponse>('/api/plugins/auth-password/sign-in', {
      method: 'POST',
      body: {
        email,
        password,
        redirectTo: redirectPath && redirectPath !== '/auth' ? redirectPath : undefined
      }
    }),
    onSuccess: async (data) => { await navigateAfterAuth(data.redirectTo) }
  })

  const error = signIn.error ? extractErrorMessage(signIn.error) : null
  const canSubmit = Boolean(email.trim()) && Boolean(password) && !signIn.isPending

  if (!authBootstrapReady || !passwordEnabled || authSetupRequired) {
    return null
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          {authTitle && <Typography level="h2">{authTitle}</Typography>}

          {mode === 'reset' ? (
            <AuthPasswordResetFlow
              initialEmail={email}
              onCancel={() => setMode('sign-in')}
              onSuccess={() => navigateAfterAuth()}
            />
          ) : (
            <>
              <Typography level="body-sm" textColor="text.tertiary">
                Sign in with your email and password.
              </Typography>

              <Box
                component="form"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (canSubmit) signIn.mutate()
                }}
              >
                <Stack spacing={1.5}>
                  {error && (
                    <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                      {error}
                    </Alert>
                  )}

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

                  <FormControl required>
                    <FormLabel>Password</FormLabel>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </FormControl>

                  <Button type="submit" loading={signIn.isPending} disabled={!canSubmit} sx={{ width: '100%' }}>
                    Sign In
                  </Button>

                  {resetAvailable && (
                    <Button variant="plain" color="neutral" size="sm" sx={{ alignSelf: 'center' }} onClick={() => setMode('reset')}>
                      Forgot password?
                    </Button>
                  )}
                </Stack>
              </Box>
            </>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
