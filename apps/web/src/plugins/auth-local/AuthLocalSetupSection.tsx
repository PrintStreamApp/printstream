import { Alert, Button, Card, CardContent, Chip, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  type EmailCodeRequestResponse,
  type EmailCodeVerifyResponse,
  extractErrorMessage,
  type AuthBootstrap,
  type BootstrapLocalAdminResponse,
  type LocalAuthStatus
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, invalidateAuthQueries, platformAuthScopeKey } from '../../lib/authQuery'

/** First-run local-auth setup card contributed to the settings auth section. */
export function AuthLocalSetupSection({
  authProviders = [],
  authSetupRequired = false,
  authBootstrapReady = false,
  authTenantId,
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
  const tenantSetup = authTenantId != null
  const [bootstrapEmail, setBootstrapEmail] = useState('')
  const [bootstrapDisplayName, setBootstrapDisplayName] = useState('')
  const [verificationEmail, setVerificationEmail] = useState('')
  const [verificationCode, setVerificationCode] = useState('')
  const [pendingVerification, setPendingVerification] = useState<{
    email: string
    expiresAt: string | null
    previewCode: string | null
  } | null>(null)
  const localAuthStatusQuery = useQuery({
    queryKey: authQueryKeys.localStatus(authScopeKey),
    queryFn: () => apiFetch<LocalAuthStatus>('/api/plugins/auth-local/status'),
    enabled: authBootstrapReady && authProviders.some((provider) => provider.id === 'auth-local' && provider.enabled)
  })

  const localAuthEnabled = authProviders.some((provider) => provider.id === 'auth-local' && provider.enabled)
  const showsAuthSetup = authSetupRequired && localAuthEnabled

  const bootstrapAdminMutation = useMutation({
    mutationFn: (input: { email: string; displayName: string | null }) =>
      apiFetch<BootstrapLocalAdminResponse>('/api/plugins/auth-local/bootstrap/admin', {
        method: 'POST',
        body: input
      }),
    onSuccess: async () => {
      setBootstrapEmail('')
      setBootstrapDisplayName('')
      await invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.localStatus(authScopeKey))
    }
  })
  const requestVerificationCodeMutation = useMutation({
    mutationFn: async (email: string) => {
      const response = await apiFetch<EmailCodeRequestResponse>('/api/plugins/auth-local/email-codes/request', {
        method: 'POST',
        body: {
          email,
          tenantId: authTenantId,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        }
      })

      if (response.requiresTenantSelection) {
        throw new Error('Choose a tenant before requesting a verification code.')
      }

      return response
    },
    onSuccess: (data, email) => {
      setPendingVerification({
        email,
        expiresAt: data.expiresAt,
        previewCode: data.previewCode ?? null
      })
    }
  })
  const verifyEmailCodeMutation = useMutation({
    mutationFn: (input: { email: string; code: string }) =>
      apiFetch<EmailCodeVerifyResponse>('/api/plugins/auth-local/email-codes/verify', {
        method: 'POST',
        body: {
          email: input.email,
          tenantId: authTenantId,
          code: input.code
        }
      }),
    onSuccess: async () => {
      setVerificationCode('')
      await Promise.all([
        invalidateAuthQueries(queryClient, authQueryKeys.bootstrap, authQueryKeys.localStatus(authScopeKey)),
        queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
      ])
    }
  })

  const localAuthStatus = localAuthStatusQuery.data

  useEffect(() => {
    if (pendingVerification?.email) {
      setVerificationEmail(pendingVerification.email)
      return
    }

    if (localAuthStatus?.initialAdminEmail) {
      setVerificationEmail((current) => current || localAuthStatus.initialAdminEmail || '')
    }
  }, [localAuthStatus?.initialAdminEmail, pendingVerification?.email])

  useEffect(() => {
    if (!authSetupRequired || localAuthStatus == null || localAuthStatus.setupRequired) {
      return
    }

    void queryClient.invalidateQueries({ queryKey: authQueryKeys.bootstrap })
  }, [authSetupRequired, localAuthStatus, queryClient])

  if (!showsAuthSetup || !canManageAuthProviders) {
    return null
  }

  const bootstrapError = bootstrapAdminMutation.error
    ? extractErrorMessage(bootstrapAdminMutation.error)
    : null
  const requestVerificationError = requestVerificationCodeMutation.error
    ? extractErrorMessage(requestVerificationCodeMutation.error)
    : null
  const verifyCodeError = verifyEmailCodeMutation.error
    ? extractErrorMessage(verifyEmailCodeMutation.error)
    : null
  const canCreateInitialAdmin = (localAuthStatus?.counts.users ?? 0) === 0
  const needsInitialAdminVerification = !canCreateInitialAdmin && actorType !== 'user'
  const localAuthStatusError = localAuthStatusQuery.error
    ? extractErrorMessage(localAuthStatusQuery.error)
    : null

  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={1.5}>
            <Typography level="body-sm" textColor="text.tertiary">
              {tenantSetup
                ? 'Invite the first workspace admin, then verify the one-time code here to finish sign-in setup.'
                : 'Set up local sign-in by creating a platform user and verifying the emailed one-time code.'}
            </Typography>

            {localAuthStatusQuery.isLoading && (
              <Typography level="body-sm" textColor="text.tertiary">
                Loading local auth setup status…
              </Typography>
            )}

            {localAuthStatusError && (
              <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                {localAuthStatusError}
              </Alert>
            )}

            {localAuthStatus && (
              <>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                  <Chip size="sm" variant="soft" color={localAuthStatus.counts.users > 0 ? 'success' : 'warning'}>
                    {localAuthStatus.counts.users} user{localAuthStatus.counts.users === 1 ? '' : 's'}
                  </Chip>
                  <Chip size="sm" variant="soft" color={localAuthStatus.counts.passkeys > 0 ? 'success' : 'warning'}>
                    {localAuthStatus.counts.passkeys} passkey{localAuthStatus.counts.passkeys === 1 ? '' : 's'}
                  </Chip>
                </Stack>

                {canCreateInitialAdmin ? (
                  <Stack
                    component="form"
                    spacing={1.25}
                    onSubmit={(event) => {
                      event.preventDefault()
                      bootstrapAdminMutation.reset()
                      requestVerificationCodeMutation.reset()
                      verifyEmailCodeMutation.reset()
                      void bootstrapAdminMutation.mutate({
                        email: bootstrapEmail,
                        displayName: bootstrapDisplayName.trim() ? bootstrapDisplayName.trim() : null
                      }, {
                        onSuccess: (data) => {
                          setBootstrapEmail('')
                          setBootstrapDisplayName('')
                          setVerificationEmail(data.user.email)
                          setVerificationCode('')
                          setPendingVerification({
                            email: data.user.email,
                            expiresAt: data.invite.expiresAt,
                            previewCode: data.invite.previewCode
                          })
                        }
                      })
                    }}
                  >
                    {tenantSetup && (
                      <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                        This creates the first admin here. The invite code can only be used for this setup.
                      </Alert>
                    )}

                    <FormControl required>
                      <FormLabel>Email</FormLabel>
                      <Input
                        type="email"
                        autoComplete="email"
                        value={bootstrapEmail}
                        onChange={(event) => setBootstrapEmail(event.target.value)}
                        placeholder={tenantSetup ? 'customer-admin@example.com' : 'admin@example.com'}
                      />
                    </FormControl>

                    <FormControl>
                      <FormLabel>Display name</FormLabel>
                      <Input
                        value={bootstrapDisplayName}
                        onChange={(event) => setBootstrapDisplayName(event.target.value)}
                        placeholder={tenantSetup ? 'Customer admin' : 'Primary admin'}
                      />
                    </FormControl>

                    {bootstrapError && (
                      <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                        {bootstrapError}
                      </Alert>
                    )}

                    <Stack direction="row" justifyContent="flex-end" spacing={1}>
                      <Button
                        type="submit"
                        loading={bootstrapAdminMutation.isPending}
                        disabled={!bootstrapEmail.trim()}
                      >
                        {tenantSetup ? 'Invite initial workspace admin' : 'Create initial admin'}
                      </Button>
                    </Stack>
                  </Stack>
                ) : needsInitialAdminVerification ? (
                  <Stack spacing={1.25}>
                    <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                      {tenantSetup
                        ? 'Open the tenant invite email, then enter the one-time code here to continue onboarding this workspace.'
                        : 'Check your email for the code, then enter it here to continue.'}
                    </Alert>

                    {pendingVerification && (
                      <Stack spacing={1}>
                        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                          <Chip size="sm" variant="soft" color="primary">{pendingVerification.email}</Chip>
                          {pendingVerification.expiresAt && (
                            <Chip size="sm" variant="soft" color="neutral">
                              Expires {new Date(pendingVerification.expiresAt).toLocaleString()}
                            </Chip>
                          )}
                        </Stack>

                        {pendingVerification.previewCode && (
                          <FormControl>
                            <FormLabel>Preview code</FormLabel>
                            <Input value={pendingVerification.previewCode} readOnly />
                          </FormControl>
                        )}

                        <Typography level="body-xs" textColor="text.tertiary">
                          {tenantSetup
                            ? 'The browser that verifies this code becomes the first signed-in workspace admin and finishes sign-in setup.'
                            : 'The browser that verifies this code becomes the first signed-in platform user and finishes local auth setup.'}
                        </Typography>
                      </Stack>
                    )}

                    <Stack
                      component="form"
                      spacing={1.25}
                      onSubmit={(event) => {
                        event.preventDefault()
                        verifyEmailCodeMutation.reset()
                        void verifyEmailCodeMutation.mutate({
                          email: verificationEmail.trim(),
                          code: verificationCode.trim()
                        })
                      }}
                    >
                      <FormControl required>
                        <FormLabel>Email</FormLabel>
                        <Input
                          type="email"
                          autoComplete="email"
                          value={verificationEmail}
                          onChange={(event) => setVerificationEmail(event.target.value)}
                          onInput={(event) => setVerificationEmail((event.target as HTMLInputElement).value)}
                          placeholder="admin@example.com"
                        />
                      </FormControl>

                      <FormControl required>
                        <FormLabel>Verification code</FormLabel>
                        <Input
                          autoComplete="one-time-code"
                          value={verificationCode}
                          onChange={(event) => setVerificationCode(event.target.value)}
                          placeholder="ABCD-EFGH"
                        />
                      </FormControl>

                      {requestVerificationError && (
                        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                          {requestVerificationError}
                        </Alert>
                      )}

                      {verifyCodeError && (
                        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                          {verifyCodeError}
                        </Alert>
                      )}

                      <Stack direction="row" justifyContent="flex-end" spacing={1}>
                        <Button
                          type="button"
                          variant="plain"
                          color="neutral"
                          loading={requestVerificationCodeMutation.isPending}
                          disabled={!verificationEmail.trim() || verifyEmailCodeMutation.isPending}
                          onClick={() => {
                            requestVerificationCodeMutation.reset()
                            void requestVerificationCodeMutation.mutate(verificationEmail.trim())
                          }}
                        >
                          {pendingVerification ? 'Resend verification code' : 'Send verification code'}
                        </Button>
                        <Button
                          type="submit"
                          loading={verifyEmailCodeMutation.isPending}
                          disabled={!verificationEmail.trim() || !verificationCode.trim() || requestVerificationCodeMutation.isPending}
                        >
                          Verify code
                        </Button>
                      </Stack>
                    </Stack>
                  </Stack>
                ) : (
                  <Alert color="warning" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
                    {tenantSetup
                      ? 'The initial workspace admin already exists. Verify the emailed code in this browser to finish sign-in setup.'
                      : 'The initial admin account already exists. Verify the emailed code in this browser to finish local auth setup.'}
                  </Alert>
                )}
              </>
            )}
          </Stack>
        </CardContent>
      </Card>
    </>
  )
}