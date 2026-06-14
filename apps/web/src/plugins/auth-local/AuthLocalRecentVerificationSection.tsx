import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, DialogActions, DialogContent, FormControl, FormLabel, Input, Stack } from '@mui/joy'
import {
  type AuthUserPasskeyListResponse,
  type AuthBootstrap,
  type EmailCodeRequestResponse,
  type EmailCodeVerifyResponse,
  extractErrorMessage,
  type PasskeyAuthenticationBeginResponse,
  type PasskeyAuthenticationFinishResponse
} from '@printstream/shared'
import { startAuthentication } from '@simplewebauthn/browser'
import { useMutation, useQuery } from '@tanstack/react-query'
import React, { useState } from 'react'
import { apiFetch } from '../../lib/apiClient'
import { useAuthBootstrapQuery } from '../../lib/authQuery'
import { getBrowserTimeZone } from '../../lib/time'

/** Local-auth implementation of the generic recent-verification slot. */
export function AuthLocalRecentVerificationSection({
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
  const [recentAuthEmailCode, setRecentAuthEmailCode] = useState('')
  const localAuthProvider = authProviders.find(
    (provider) => provider.id === 'auth-local' && provider.enabled && (provider.capabilities.recentVerificationMethods?.length ?? 0) > 0
  )
  const recentVerificationMethods = localAuthProvider?.capabilities.recentVerificationMethods ?? []
  const supportsPasskey = recentVerificationMethods.includes('passkey')
  const authBootstrapQuery = useAuthBootstrapQuery({
    enabled: supportsPasskey,
    suppressGlobalErrorToast: true
  })
  const canQuerySelfPasskeys = supportsPasskey && authBootstrapQuery.data?.actor.type === 'user'
  const selfPasskeysQuery = useQuery({
    queryKey: ['auth-local-self-passkeys'],
    queryFn: () => apiFetch<AuthUserPasskeyListResponse>('/api/plugins/auth-local/passkeys'),
    enabled: canQuerySelfPasskeys,
    meta: { suppressGlobalErrorToast: true }
  })

  const recentAuthPasskeyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async () => {
      const begin = await apiFetch<PasskeyAuthenticationBeginResponse>('/api/plugins/auth-local/passkeys/authenticate/options', {
        method: 'POST'
      })
      const response = await startAuthentication(begin.options as never)
      return await apiFetch<PasskeyAuthenticationFinishResponse>('/api/plugins/auth-local/passkeys/authenticate/verify', {
        method: 'POST',
        body: { response }
      })
    },
    onSuccess: async () => {
      await onVerified?.()
    }
  })
  const recentAuthEmailCodeRequestMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: () => apiFetch<EmailCodeRequestResponse>('/api/plugins/auth-local/email-codes/request', {
      method: 'POST',
      body: {
        email,
        redirectTo: readCurrentRoutePath(),
        timeZone: getBrowserTimeZone()
      }
    })
  })
  const recentAuthEmailCodeVerifyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: () => apiFetch<EmailCodeVerifyResponse>('/api/plugins/auth-local/email-codes/verify', {
      method: 'POST',
      body: {
        email,
        code: recentAuthEmailCode
      }
    }),
    onSuccess: async () => {
      await onVerified?.()
    }
  })

  if (!localAuthProvider) {
    return null
  }

  const error = recentAuthEmailCodeRequestMutation.error
    ? extractErrorMessage(recentAuthEmailCodeRequestMutation.error)
    : recentAuthEmailCodeVerifyMutation.error
      ? extractErrorMessage(recentAuthEmailCodeVerifyMutation.error)
      : recentAuthPasskeyMutation.error
        ? extractErrorMessage(recentAuthPasskeyMutation.error)
        : null
  const supportsEmailCode = recentVerificationMethods.includes('email-code')
  const canVerifyWithPasskey = supportsPasskey && (selfPasskeysQuery.data?.passkeys.length ?? 0) > 0
  const verificationByEmail = recentAuthEmailCodeRequestMutation.isSuccess

  return (
    <>
      <DialogContent>
        <Stack spacing={1.25}>
          {error && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {error}
            </Alert>
          )}

          {verificationByEmail && supportsEmailCode && (
            <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
              Verification code sent to {email}. Enter it below to continue.
            </Alert>
          )}

          {recentAuthEmailCodeRequestMutation.data?.previewCode && (
            <FormControl>
              <FormLabel>Preview code</FormLabel>
              <Input value={recentAuthEmailCodeRequestMutation.data.previewCode} readOnly />
            </FormControl>
          )}

          {verificationByEmail && supportsEmailCode && (
            <FormControl required>
              <FormLabel>Verification code</FormLabel>
              <Input
                value={recentAuthEmailCode}
                onChange={(event) => setRecentAuthEmailCode(event.target.value)}
                onInput={(event) => setRecentAuthEmailCode((event.target as HTMLInputElement).value)}
                autoComplete="one-time-code"
                placeholder="ABCD-EFGH"
              />
            </FormControl>
          )}
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
        <Button
          variant="plain"
          color="neutral"
          onClick={onClose}
          disabled={recentAuthPasskeyMutation.isPending || recentAuthEmailCodeRequestMutation.isPending || recentAuthEmailCodeVerifyMutation.isPending}
        >
          Cancel
        </Button>
        {supportsEmailCode && (
          <Button
            variant="soft"
            color="neutral"
            loading={recentAuthEmailCodeRequestMutation.isPending}
            disabled={!email.trim() || recentAuthPasskeyMutation.isPending || recentAuthEmailCodeVerifyMutation.isPending}
            onClick={() => recentAuthEmailCodeRequestMutation.mutate()}
          >
            {verificationByEmail ? 'Resend verification code' : 'Email verification code'}
          </Button>
        )}
        {!verificationByEmail && canVerifyWithPasskey && (
          <Button
            variant="soft"
            color="neutral"
            loading={recentAuthPasskeyMutation.isPending}
            disabled={recentAuthEmailCodeRequestMutation.isPending || recentAuthEmailCodeVerifyMutation.isPending}
            onClick={() => recentAuthPasskeyMutation.mutate()}
          >
            Verify with passkey
          </Button>
        )}
        {verificationByEmail && supportsEmailCode && (
          <Button
            loading={recentAuthEmailCodeVerifyMutation.isPending}
            disabled={!recentAuthEmailCode.trim() || recentAuthPasskeyMutation.isPending || recentAuthEmailCodeRequestMutation.isPending}
            onClick={() => recentAuthEmailCodeVerifyMutation.mutate()}
          >
            Verify code
          </Button>
        )}
      </DialogActions>
    </>
  )
}

function readCurrentRoutePath(): string {
  if (typeof window === 'undefined') return '/'
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}