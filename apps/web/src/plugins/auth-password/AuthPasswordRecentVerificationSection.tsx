import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, DialogActions, DialogContent, FormControl, FormLabel, Input, Stack } from '@mui/joy'
import {
  type AuthBootstrap,
  extractErrorMessage,
  type PasswordSignInResponse
} from '@printstream/shared'
import { useMutation } from '@tanstack/react-query'
import React, { useState } from 'react'
import { apiFetch } from '../../lib/apiClient'

/**
 * Password implementation of the generic recent-verification slot. Re-entering
 * the password mints a fresh session, which re-establishes a "recent" sign-in.
 */
export function AuthPasswordRecentVerificationSection({
  authProviders = [],
  email = '',
  onClose,
  onVerified
}: {
  authProviders?: AuthBootstrap['providers']
  email?: string
  onClose?: () => void
  onVerified?: () => void | Promise<void>
}) {
  const [password, setPassword] = useState('')
  const passwordProvider = authProviders.find(
    (provider) => provider.id === 'auth-password' && provider.enabled && (provider.capabilities.recentVerificationMethods?.length ?? 0) > 0
  )

  const verifyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: () => apiFetch<PasswordSignInResponse>('/api/plugins/auth-password/sign-in', {
      method: 'POST',
      body: { email, password }
    }),
    onSuccess: async () => {
      await onVerified?.()
    }
  })

  if (!passwordProvider) {
    return null
  }

  const error = verifyMutation.error ? extractErrorMessage(verifyMutation.error) : null
  const canVerify = Boolean(password) && !verifyMutation.isPending

  return (
    <>
      <DialogContent>
        <Stack
          component="form"
          spacing={1.25}
          onSubmit={(event) => {
            event.preventDefault()
            if (canVerify) verifyMutation.mutate()
          }}
        >
          {error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {error}
            </Alert>
          )}

          <FormControl required>
            <FormLabel>Password</FormLabel>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </FormControl>
        </Stack>
      </DialogContent>

      <DialogActions
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column-reverse', sm: 'row' },
          alignItems: { xs: 'stretch', sm: 'center' },
          '& > button': { width: { xs: '100%', sm: 'auto' } }
        }}
      >
        <Button variant="plain" color="neutral" onClick={onClose} disabled={verifyMutation.isPending}>
          Cancel
        </Button>
        <Button loading={verifyMutation.isPending} disabled={!canVerify} onClick={() => verifyMutation.mutate()}>
          Verify password
        </Button>
      </DialogActions>
    </>
  )
}
