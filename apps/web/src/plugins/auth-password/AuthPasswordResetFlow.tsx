import { Alert, Box, Button, FormControl, FormHelperText, FormLabel, Input, Stack, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import {
  extractErrorMessage,
  PASSWORD_MIN_LENGTH,
  type PasswordResetRequestResponse,
  type PasswordSignInResponse
} from '@printstream/shared'
import { useMutation } from '@tanstack/react-query'
import React, { useState } from 'react'
import { apiFetch } from '../../lib/apiClient'

/**
 * Email password-reset flow (request a code, then set a new password). Rendered
 * by the sign-in section only when reset-by-email is available.
 */
export function AuthPasswordResetFlow({
  initialEmail,
  onCancel,
  onSuccess
}: {
  initialEmail: string
  onCancel: () => void
  onSuccess: () => Promise<void> | void
}) {
  const [email, setEmail] = useState(initialEmail)
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [sent, setSent] = useState(false)

  const requestCode = useMutation({
    mutationFn: () => apiFetch<PasswordResetRequestResponse>('/api/plugins/auth-password/password-reset/request', {
      method: 'POST',
      body: { email: email.trim() }
    }),
    onSuccess: () => setSent(true)
  })

  const verify = useMutation({
    mutationFn: () => apiFetch<PasswordSignInResponse>('/api/plugins/auth-password/password-reset/verify', {
      method: 'POST',
      body: { email: email.trim(), code: code.trim(), newPassword }
    }),
    onSuccess: async () => { await onSuccess() }
  })

  const passwordsMatch = newPassword === confirmPassword
  const passwordLongEnough = newPassword.length >= PASSWORD_MIN_LENGTH
  const canVerify = Boolean(code.trim()) && passwordLongEnough && passwordsMatch && !verify.isPending
  const requestError = requestCode.error ? extractErrorMessage(requestCode.error) : null
  const verifyError = verify.error ? extractErrorMessage(verify.error) : null

  return (
    <Box component="form" onSubmit={(event) => { event.preventDefault(); if (sent) { if (canVerify) verify.mutate() } else if (email.trim()) requestCode.mutate() }}>
      <Stack spacing={1.5}>
        <Typography level="body-sm" textColor="text.tertiary">
          {sent
            ? 'Enter the code we emailed you and choose a new password.'
            : 'Enter your email and we’ll send a password reset code.'}
        </Typography>

        {sent && !requestError && (
          <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
            If that email matches an account, a reset code is on its way.
          </Alert>
        )}
        {requestError && (
          <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{requestError}</Alert>
        )}

        <FormControl required>
          <FormLabel>Email</FormLabel>
          <Input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="admin@example.com" />
        </FormControl>

        {sent && (
          <>
            <FormControl required>
              <FormLabel>Reset code</FormLabel>
              <Input autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste the code from your email" />
            </FormControl>
            <FormControl required error={newPassword.length > 0 && !passwordLongEnough}>
              <FormLabel>New password</FormLabel>
              <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              <FormHelperText>Use at least {PASSWORD_MIN_LENGTH} characters.</FormHelperText>
            </FormControl>
            <FormControl required error={confirmPassword.length > 0 && !passwordsMatch}>
              <FormLabel>Confirm new password</FormLabel>
              <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              {confirmPassword.length > 0 && !passwordsMatch && <FormHelperText>Passwords do not match.</FormHelperText>}
            </FormControl>
            {verifyError && (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>{verifyError}</Alert>
            )}
          </>
        )}

        {sent ? (
          <Button type="submit" loading={verify.isPending} disabled={!canVerify} sx={{ width: '100%' }}>
            Reset password
          </Button>
        ) : (
          <Button type="submit" loading={requestCode.isPending} disabled={!email.trim()} sx={{ width: '100%' }}>
            Send reset code
          </Button>
        )}

        <Stack direction="row" justifyContent="space-between">
          <Button variant="plain" color="neutral" size="sm" onClick={onCancel}>Back to sign in</Button>
          {sent && (
            <Button variant="plain" color="neutral" size="sm" loading={requestCode.isPending} onClick={() => requestCode.mutate()}>
              Resend code
            </Button>
          )}
        </Stack>
      </Stack>
    </Box>
  )
}
