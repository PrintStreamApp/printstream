import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, FormControl, FormHelperText, FormLabel, Input, Sheet, Stack } from '@mui/joy'
import {
  type AuthBootstrap,
  type AuthUser,
  extractErrorMessage,
  PASSWORD_MIN_LENGTH
} from '@printstream/shared'
import { useMutation } from '@tanstack/react-query'
import React, { useState } from 'react'
import { apiFetch } from '../../lib/apiClient'
import { DialogSection } from '../../components/DialogSection'

/** Admin set/reset/remove of a managed user's password (the OSS provider). */
export function AuthPasswordUserCredentialsSection({
  user,
  authProviders = [],
  mutatingLifecycle = false,
  canEditUser = false
}: {
  user?: AuthUser
  authProviders?: AuthBootstrap['providers']
  mutatingLifecycle?: boolean
  canEditUser?: boolean
}) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const passwordManaged = authProviders.some(
    (provider) => provider.id === 'auth-password' && provider.enabled && provider.capabilities.adminUserCredentials
  )

  const setPasswordMutation = useMutation({
    mutationFn: (input: { userId: string; password: string }) =>
      apiFetch<void>(`/api/plugins/auth-password/users/${input.userId}/password`, {
        method: 'POST',
        body: { password: input.password }
      }),
    onSuccess: () => {
      setPassword('')
      setConfirmPassword('')
    }
  })
  const removePasswordMutation = useMutation({
    mutationFn: (userId: string) =>
      apiFetch<void>(`/api/plugins/auth-password/users/${userId}/password`, {
        method: 'DELETE'
      })
  })

  if (!user || !passwordManaged || !canEditUser) {
    return null
  }

  const passwordsMatch = password === confirmPassword
  const passwordLongEnough = password.length >= PASSWORD_MIN_LENGTH
  const canSubmit = passwordLongEnough && passwordsMatch && !setPasswordMutation.isPending && !mutatingLifecycle
  const error = setPasswordMutation.error
    ? extractErrorMessage(setPasswordMutation.error)
    : removePasswordMutation.error
      ? extractErrorMessage(removePasswordMutation.error)
      : null

  return (
    <DialogSection
      title="Password"
      description="Set or reset this user's password. They will be prompted to choose a new one on next sign-in."
      wrapInSheet={false}
    >
      <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
        <Stack
          component="form"
          spacing={1.25}
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) setPasswordMutation.mutate({ userId: user.id, password })
          }}
        >
          {error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {error}
            </Alert>
          )}

          {setPasswordMutation.isSuccess && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
              Password set. Share it securely; the user will be asked to change it on next sign-in.
            </Alert>
          )}

          {removePasswordMutation.isSuccess && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
              Password removed.
            </Alert>
          )}

          <FormControl required error={password.length > 0 && !passwordLongEnough}>
            <FormLabel>New password</FormLabel>
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

          <Stack direction="row" justifyContent="space-between" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant="plain"
              color="danger"
              loading={removePasswordMutation.isPending}
              disabled={setPasswordMutation.isPending || mutatingLifecycle}
              onClick={() => removePasswordMutation.mutate(user.id)}
            >
              Remove password
            </Button>
            <Button type="submit" loading={setPasswordMutation.isPending} disabled={!canSubmit}>
              Set password
            </Button>
          </Stack>
        </Stack>
      </Sheet>
    </DialogSection>
  )
}
