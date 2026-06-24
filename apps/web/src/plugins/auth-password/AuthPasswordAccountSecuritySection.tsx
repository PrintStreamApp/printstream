import { Alert, Button, Card, CardContent, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  type AccountPasswordStatus,
  type AuthBootstrap,
  extractErrorMessage,
  PASSWORD_MIN_LENGTH
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import { apiFetch } from '../../lib/apiClient'

const PASSWORD_STATUS_QUERY_KEY = ['auth-password-self-status'] as const

/** Self-service password management contributed to the account security panel. */
export function AuthPasswordAccountSecuritySection({
  actorType = 'anonymous',
  authProviders = [],
  authBootstrapReady = false
}: {
  actorType?: string
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
}) {
  const queryClient = useQueryClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const passwordEnabled = authProviders.some((provider) => provider.id === 'auth-password' && provider.enabled)
  const isAuthenticatedUser = actorType === 'user'

  const statusQuery = useQuery({
    queryKey: PASSWORD_STATUS_QUERY_KEY,
    queryFn: () => apiFetch<AccountPasswordStatus>('/api/plugins/auth-password/me/password'),
    enabled: authBootstrapReady && passwordEnabled && isAuthenticatedUser
  })

  const changeMutation = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      apiFetch<void>('/api/plugins/auth-password/me/password/change', {
        method: 'POST',
        body: input
      }),
    onSuccess: async () => {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      await queryClient.invalidateQueries({ queryKey: PASSWORD_STATUS_QUERY_KEY })
    }
  })

  if (!authBootstrapReady || !passwordEnabled || !isAuthenticatedUser) {
    return null
  }

  const status = statusQuery.data
  const passwordsMatch = newPassword === confirmPassword
  const passwordLongEnough = newPassword.length >= PASSWORD_MIN_LENGTH
  const canSubmit = Boolean(currentPassword) && passwordLongEnough && passwordsMatch && !changeMutation.isPending
  const error = changeMutation.error ? extractErrorMessage(changeMutation.error) : null

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Typography level="title-sm">Password</Typography>

          {status?.mustChangePassword && (
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              An admin set your password. Choose a new one to continue securely.
            </Alert>
          )}

          {changeMutation.isSuccess && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
              Your password has been changed.
            </Alert>
          )}

          <Stack
            component="form"
            spacing={1.25}
            onSubmit={(event) => {
              event.preventDefault()
              if (!canSubmit) return
              changeMutation.mutate({ currentPassword, newPassword })
            }}
          >
            <FormControl required>
              <FormLabel>Current password</FormLabel>
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </FormControl>

            <FormControl required error={newPassword.length > 0 && !passwordLongEnough}>
              <FormLabel>New password</FormLabel>
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <FormHelperText>Use at least {PASSWORD_MIN_LENGTH} characters.</FormHelperText>
            </FormControl>

            <FormControl required error={confirmPassword.length > 0 && !passwordsMatch}>
              <FormLabel>Confirm new password</FormLabel>
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
              <Button type="submit" loading={changeMutation.isPending} disabled={!canSubmit}>
                Change password
              </Button>
            </Stack>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  )
}
