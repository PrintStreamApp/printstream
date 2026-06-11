import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, Card, CardContent, DialogActions, DialogContent, DialogTitle, FormControl, FormLabel, Input, ModalDialog, Stack, Typography } from '@mui/joy'
import {
  AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE,
  type AuthBootstrap,
  type AuthUser,
  type AuthUserResponse,
  type AuthUserPasskey,
  type AuthUserPasskeyListResponse,
  extractErrorMessage,
  type PasskeyRegistrationBeginResponse,
  type PasskeyRegistrationFinishResponse,
  type RequestCurrentAuthUserEmailChangeResponse
} from '@printstream/shared'
import { startRegistration } from '@simplewebauthn/browser'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { useEffect, useState } from 'react'
import { apiFetch } from '../../lib/apiClient'
import { getBrowserTimeZone } from '../../lib/time'
import { AuthPasskeyList } from '../../components/AuthPasskeyList'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { PasskeyRegistrationDialog } from '../../components/PasskeyRegistrationDialog'
import { ProviderRecentVerificationDialog } from '../../components/ProviderRecentVerificationDialog'

type PendingSensitiveAction =
  | { type: 'register-passkey'; nickname: string | null }
  | { type: 'revoke-passkey'; passkeyId: string }

type PendingEmailChange = {
  email: string
}

type AuthLocalAccountSecuritySectionProps = {
  actorType?: string
  currentProfile?: AuthUser | null
  profileLoading?: boolean
  authProviders?: AuthBootstrap['providers']
  authBootstrapReady?: boolean
}

export function AuthLocalAccountSecuritySection({
  actorType = 'anonymous',
  currentProfile = null,
  profileLoading = false,
  authProviders = [],
  authBootstrapReady = false
}: AuthLocalAccountSecuritySectionProps) {
  const queryClient = useQueryClient()
  const [emailDraft, setEmailDraft] = useState('')
  const [passkeyRegistrationDialogOpen, setPasskeyRegistrationDialogOpen] = useState(false)
  const [pendingSensitiveAction, setPendingSensitiveAction] = useState<PendingSensitiveAction | null>(null)
  const [pendingEmailChange, setPendingEmailChange] = useState<PendingEmailChange | null>(null)
  const [emailChangeCode, setEmailChangeCode] = useState('')

  useEffect(() => {
    setEmailDraft(currentProfile?.email ?? '')
  }, [currentProfile?.email])

  const isAuthenticatedUser = actorType === 'user'
  const localAuthEnabled = authProviders.some((provider) => provider.id === 'auth-local' && provider.enabled)
  const selfPasskeysQuery = useQuery({
    queryKey: ['auth-local-self-passkeys'],
    queryFn: () => apiFetch<AuthUserPasskeyListResponse>('/api/plugins/auth-local/passkeys'),
    enabled: localAuthEnabled && isAuthenticatedUser,
    meta: { suppressGlobalErrorToast: true }
  })

  function isRecentAuthError(error: unknown): boolean {
    return extractErrorMessage(error) === AUTH_RECENT_VERIFICATION_REQUIRED_MESSAGE
  }

  async function executeSensitiveAction(action: PendingSensitiveAction) {
    switch (action.type) {
      case 'register-passkey':
        await registerPasskeyMutation.mutateAsync(action.nickname)
        setPasskeyRegistrationDialogOpen(false)
        return
      case 'revoke-passkey':
        await revokeSelfPasskeyMutation.mutateAsync(action.passkeyId)
    }
  }

  function openRecentAuthDialog(action: PendingSensitiveAction) {
    setPendingSensitiveAction(action)
  }

  function closeRecentAuthDialog() {
    setPendingSensitiveAction(null)
  }

  function openEmailChangeDialog(change: PendingEmailChange) {
    setPendingEmailChange(change)
    setEmailChangeCode('')
    emailChangeCodeRequestMutation.reset()
    emailChangeVerifyMutation.reset()
    emailChangeCodeRequestMutation.mutate(change)
  }

  function closeEmailChangeDialog() {
    if (emailChangeCodeRequestMutation.isPending || emailChangeVerifyMutation.isPending) {
      return
    }
    setPendingEmailChange(null)
    setEmailChangeCode('')
    emailChangeCodeRequestMutation.reset()
    emailChangeVerifyMutation.reset()
  }

  async function handleRecentVerificationSuccess() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-self-profile'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
    ])

    const pendingAction = pendingSensitiveAction
    setPendingSensitiveAction(null)

    if (!pendingAction) {
      return
    }

    try {
      await executeSensitiveAction(pendingAction)
    } catch (error) {
      if (isRecentAuthError(error)) {
        setPendingSensitiveAction(pendingAction)
        return
      }
      throw error
    }
  }

  const registerPasskeyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: async (nickname: string | null) => {
      const begin = await apiFetch<PasskeyRegistrationBeginResponse>('/api/plugins/auth-local/passkeys/register/options', {
        method: 'POST'
      })
      const response = await startRegistration(begin.options as never)
      return await apiFetch<PasskeyRegistrationFinishResponse>('/api/plugins/auth-local/passkeys/register/verify', {
        method: 'POST',
        body: {
          response,
          nickname
        }
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['local-auth-status'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
      ])
    },
    onError: (error, nickname) => {
      if (isRecentAuthError(error)) {
        openRecentAuthDialog({ type: 'register-passkey', nickname })
      }
    }
  })
  const revokeSelfPasskeyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (passkeyId: string) =>
      apiFetch<void>(`/api/plugins/auth-local/passkeys/${passkeyId}/revoke`, {
        method: 'POST'
      }),
    onError: (error, passkeyId) => {
      if (isRecentAuthError(error)) {
        openRecentAuthDialog({ type: 'revoke-passkey', passkeyId })
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['local-auth-status'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
      ])
    }
  })
  const emailChangeCodeRequestMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: PendingEmailChange) => apiFetch<RequestCurrentAuthUserEmailChangeResponse>('/api/plugins/auth-local/me/email-change/request', {
      method: 'POST',
      body: {
        ...body,
        timeZone: getBrowserTimeZone()
      }
    })
  })
  const emailChangeVerifyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: PendingEmailChange) => apiFetch<AuthUserResponse>('/api/plugins/auth-local/me/email-change/verify', {
      method: 'POST',
      body: {
        email: body.email,
        code: emailChangeCode,
        displayName: currentProfile?.displayName ?? null
      }
    }),
    onSuccess: async () => {
      setPendingEmailChange(null)
      setEmailChangeCode('')
      emailChangeCodeRequestMutation.reset()
      emailChangeVerifyMutation.reset()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-self-profile'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-users'] })
      ])
    }
  })
  const updateSelfPasskeyMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: ({ passkeyId, nickname }: { passkeyId: string; nickname: string | null }) =>
      apiFetch<{ passkey: AuthUserPasskey }>(`/api/plugins/auth-local/passkeys/${passkeyId}`, {
        method: 'PATCH',
        body: { nickname }
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
    }
  })

  if (!authBootstrapReady || !localAuthEnabled || !isAuthenticatedUser) {
    return null
  }

  const normalizedEmail = emailDraft.trim().toLowerCase()
  const hasEmailChange = currentProfile != null && normalizedEmail.length > 0 && normalizedEmail !== currentProfile.email
  const passkeys = selfPasskeysQuery.data?.passkeys ?? []
  const passkeyError = registerPasskeyMutation.error
    ? (isRecentAuthError(registerPasskeyMutation.error) ? null : extractErrorMessage(registerPasskeyMutation.error))
    : selfPasskeysQuery.error
      ? extractErrorMessage(selfPasskeysQuery.error)
      : revokeSelfPasskeyMutation.error
          ? (isRecentAuthError(revokeSelfPasskeyMutation.error) ? null : extractErrorMessage(revokeSelfPasskeyMutation.error))
          : updateSelfPasskeyMutation.error
            ? extractErrorMessage(updateSelfPasskeyMutation.error)
            : null
  const emailChangeError = emailChangeCodeRequestMutation.error
    ? extractErrorMessage(emailChangeCodeRequestMutation.error)
    : emailChangeVerifyMutation.error
      ? extractErrorMessage(emailChangeVerifyMutation.error)
      : null
  const recentAuthDialogTitle = pendingSensitiveAction?.type === 'register-passkey'
    ? 'Verify to create a passkey'
    : 'Verify to revoke this passkey'
  const recentAuthDialogDescription = pendingSensitiveAction?.type === 'register-passkey'
    ? 'For security, confirm it is really you before creating another sign-in credential for this account.'
    : 'For security, confirm it is really you before removing a sign-in credential from this account.'
  const recentAuthDialogEmail = currentProfile?.email ?? normalizedEmail

  return (
    <>
      <Card variant="outlined">
        <CardContent>
          <Stack spacing={2}>
            <Typography level="title-sm">Local sign-in methods</Typography>

            <Stack spacing={1.25}>
              {emailChangeError && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {emailChangeError}
                </Alert>
              )}

              {profileLoading && !currentProfile ? (
                <Typography level="body-sm" textColor="text.tertiary">
                  Loading local sign-in details…
                </Typography>
              ) : (
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'flex-end' }}>
                  <FormControl required sx={{ flex: 1 }}>
                    <FormLabel>Email address</FormLabel>
                    <Input
                      type="email"
                      value={emailDraft}
                      onChange={(event) => setEmailDraft(event.target.value)}
                      onInput={(event) => setEmailDraft((event.target as HTMLInputElement).value)}
                      disabled={emailChangeCodeRequestMutation.isPending || emailChangeVerifyMutation.isPending || currentProfile == null}
                      placeholder="name@example.com"
                    />
                  </FormControl>
                  <Button
                    loading={emailChangeCodeRequestMutation.isPending || emailChangeVerifyMutation.isPending}
                    disabled={!hasEmailChange}
                    sx={{ flexShrink: 0 }}
                    onClick={() => {
                      if (normalizedEmail.length === 0 || !currentProfile) {
                        return
                      }
                      openEmailChangeDialog({ email: normalizedEmail })
                    }}
                  >
                    Change email
                  </Button>
                </Stack>
              )}
            </Stack>

            <Stack spacing={1.5}>
              <Stack spacing={1} alignItems="flex-start">
                <Typography level="body-sm" fontWeight="lg">My passkeys</Typography>
                <Button loading={registerPasskeyMutation.isPending} onClick={() => setPasskeyRegistrationDialogOpen(true)}>
                  Create passkey
                </Button>
              </Stack>

              {passkeyError && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {passkeyError}
                </Alert>
              )}

              {selfPasskeysQuery.isLoading ? (
                <Typography level="body-sm" textColor="text.tertiary">
                  Loading your passkeys…
                </Typography>
              ) : (
                <AuthPasskeyList
                  passkeys={passkeys}
                  emptyMessage="No passkeys registered on this account. You can still sign in with an email code."
                  renamingPasskeyId={updateSelfPasskeyMutation.isPending ? updateSelfPasskeyMutation.variables?.passkeyId ?? null : null}
                  revokingPasskeyId={revokeSelfPasskeyMutation.isPending ? revokeSelfPasskeyMutation.variables ?? null : null}
                  onRename={(passkeyId, nickname) => updateSelfPasskeyMutation.mutate({ passkeyId, nickname })}
                  onRevoke={(passkeyId) => {
                    revokeSelfPasskeyMutation.mutate(passkeyId)
                  }}
                />
              )}
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      <PasskeyRegistrationDialog
        open={passkeyRegistrationDialogOpen}
        title="Register passkey"
        description="Give this passkey a friendly name before the browser opens the passkey registration prompt."
        confirmLabel="Continue"
        loading={registerPasskeyMutation.isPending}
        error={passkeyError}
        onClose={() => setPasskeyRegistrationDialogOpen(false)}
        onConfirm={(nickname) => {
          registerPasskeyMutation.mutate(nickname, {
            onSuccess: () => setPasskeyRegistrationDialogOpen(false)
          })
        }}
      />

      <ProviderRecentVerificationDialog
        open={pendingSensitiveAction != null}
        title={recentAuthDialogTitle}
        description={recentAuthDialogDescription}
        email={recentAuthDialogEmail}
        authProviders={authProviders}
        onClose={closeRecentAuthDialog}
        onVerified={handleRecentVerificationSuccess}
      />

      <Modal open={pendingEmailChange != null} onClose={closeEmailChangeDialog}>
        <ModalDialog variant="outlined" sx={{ width: 'min(560px, 100%)' }}>
          <DialogTitle>Verify your new email address</DialogTitle>
          <DialogContent>
            <Stack spacing={1.25}>
              <Typography level="body-sm" textColor="text.tertiary">
                Confirm the new sign-in address before this account email changes. The code is sent to {pendingEmailChange?.email ?? normalizedEmail} so typos and someone else&apos;s inbox cannot be saved here.
              </Typography>

              {emailChangeError && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {emailChangeError}
                </Alert>
              )}

              {emailChangeCodeRequestMutation.isSuccess && pendingEmailChange && (
                <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
                  Verification code sent to {pendingEmailChange.email}. Enter it below to finish changing this account email.
                </Alert>
              )}

              {emailChangeCodeRequestMutation.data?.previewCode && (
                <FormControl>
                  <FormLabel>Preview code</FormLabel>
                  <Input value={emailChangeCodeRequestMutation.data.previewCode} readOnly />
                </FormControl>
              )}

              <FormControl required>
                <FormLabel>Verification code</FormLabel>
                <Input
                  value={emailChangeCode}
                  onChange={(event) => setEmailChangeCode(event.target.value)}
                  onInput={(event) => setEmailChangeCode((event.target as HTMLInputElement).value)}
                  autoComplete="one-time-code"
                  placeholder="ABCD-EFGH"
                />
              </FormControl>
            </Stack>
          </DialogContent>

          <DialogActions>
            <Button
              variant="plain"
              color="neutral"
              onClick={closeEmailChangeDialog}
              disabled={emailChangeCodeRequestMutation.isPending || emailChangeVerifyMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="soft"
              color="neutral"
              loading={emailChangeCodeRequestMutation.isPending}
              disabled={!pendingEmailChange?.email || emailChangeVerifyMutation.isPending}
              onClick={() => pendingEmailChange && emailChangeCodeRequestMutation.mutate(pendingEmailChange)}
            >
              Resend verification code
            </Button>
            <Button
              loading={emailChangeVerifyMutation.isPending}
              disabled={!emailChangeCode.trim() || emailChangeCodeRequestMutation.isPending || !pendingEmailChange}
              onClick={() => pendingEmailChange && emailChangeVerifyMutation.mutate(pendingEmailChange)}
            >
              Verify email
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  )
}