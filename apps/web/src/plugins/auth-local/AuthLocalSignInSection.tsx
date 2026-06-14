import { Alert, Box, Button, Card, CardContent, Divider, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import {
  type EmailCodeRequestResponse,
  type EmailCodeVerifyResponse,
  extractErrorMessage,
  type AuthBootstrap,
  type PasskeyAuthenticationBeginResponse,
  type PasskeyAuthenticationFinishResponse
} from '@printstream/shared'
import { startAuthentication } from '@simplewebauthn/browser'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, buildAuthBootstrapQueryOptions, readCurrentAuthBootstrapScopeKey } from '../../lib/authQuery'
import { resolvePostAuthRedirectPath } from '../../lib/postAuthRedirect'
import { getBrowserTimeZone } from '../../lib/time'

type InviteLinkState = {
  email: string
  isInvite: boolean
  tenantId: string | null
  tenantName: string | null
  useEmailCode: boolean
}

/** Local-auth sign-in panel contributed to the core auth screen. */
export function AuthLocalSignInSection({
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
  const location = useLocation()
  const navigate = useNavigate()
  const inviteLinkState = useMemo(() => readInviteLinkState(location.search), [location.search])
  const [email, setEmail] = useState(() => inviteLinkState.email)
  const [emailCode, setEmailCode] = useState('')
  const [emailFlowSelected, setEmailFlowSelected] = useState(() => inviteLinkState.useEmailCode)
  const [emailCodePreviewCode, setEmailCodePreviewCode] = useState<string | null>(null)
  const [emailCodeRequested, setEmailCodeRequested] = useState(false)
  const [tenantOptions, setTenantOptions] = useState<AuthBootstrap['availableTenants']>([])
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(() => inviteLinkState.tenantId)
  const localAuthEnabled = authProviders.some((provider) => provider.id === 'auth-local' && provider.enabled)

  function resetEmailCodeFeedback(clearTenantOptions = true) {
    setEmailCodeRequested(false)
    setEmailCodePreviewCode(null)
    setEmailCode('')
    if (clearTenantOptions) {
      setTenantOptions([])
      setSelectedTenantId(null)
    }
    requestEmailCode.reset()
    verifyEmailCode.reset()
  }

  function handleEmailChange(nextEmail: string) {
    setEmail(nextEmail)
    if (emailCodeRequested || requestEmailCode.isError || verifyEmailCode.isError) {
      resetEmailCodeFeedback()
    }
  }

  async function navigateAfterAuth() {
    await queryClient.invalidateQueries({ queryKey: authQueryKeys.bootstrap })
    const bootstrap = await queryClient.fetchQuery(buildAuthBootstrapQueryOptions(readCurrentAuthBootstrapScopeKey()))
    navigate(resolvePostAuthRedirectPath(bootstrap, redirectPath), { replace: true })
  }

  const signIn = useMutation({
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
      await navigateAfterAuth()
    }
  })
  const requestEmailCode = useMutation({
    mutationFn: async () => apiFetch<EmailCodeRequestResponse>('/api/plugins/auth-local/email-codes/request', {
      method: 'POST',
      body: {
        email,
        tenantId: selectedTenantId ?? undefined,
        redirectTo: redirectPath && redirectPath !== '/auth' ? redirectPath : undefined,
        timeZone: getBrowserTimeZone()
      }
    }),
    onSuccess: (data) => {
      if (data.requiresTenantSelection) {
        setTenantOptions(data.tenants)
        setSelectedTenantId((current) => data.tenants.some((tenant) => tenant.id === current) ? current : null)
        setEmailCodeRequested(false)
        setEmailCodePreviewCode(null)
        return
      }

      setTenantOptions([])
      setEmailCodeRequested(true)
      setEmailCodePreviewCode(data.previewCode ?? null)
    }
  })
  const verifyEmailCode = useMutation({
    mutationFn: async () => apiFetch<EmailCodeVerifyResponse>('/api/plugins/auth-local/email-codes/verify', {
      method: 'POST',
      body: {
        email,
        tenantId: selectedTenantId ?? undefined,
        code: emailCode
      }
    }),
    onSuccess: async (data) => {
      if (data.redirectTo && data.redirectTo !== '/auth') {
        await queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] })
        navigate(data.redirectTo, { replace: true })
        return
      }
      await navigateAfterAuth()
    }
  })

  const passkeyError = signIn.error ? extractErrorMessage(signIn.error) : null
  const emailCodeRequestError = requestEmailCode.error ? extractErrorMessage(requestEmailCode.error) : null
  const emailCodeVerifyError = verifyEmailCode.error ? extractErrorMessage(verifyEmailCode.error) : null
  const showVerificationSection = inviteLinkState.useEmailCode || emailCodeRequested || verifyEmailCode.isError
  const canRequestEmailCode =
    Boolean(email.trim()) &&
    !verifyEmailCode.isPending &&
    !(tenantOptions.length > 0 && !selectedTenantId)
  const canVerifyEmailCode =
    Boolean(email.trim()) &&
    Boolean(emailCode.trim()) &&
    !requestEmailCode.isPending &&
    !(tenantOptions.length > 0 && !selectedTenantId)

  function handleRequestEmailCode() {
    if (canRequestEmailCode && !requestEmailCode.isPending) {
      verifyEmailCode.reset()
      requestEmailCode.mutate()
    }
  }

  function handleVerifyEmailCode() {
    if (canVerifyEmailCode && !verifyEmailCode.isPending) {
      verifyEmailCode.mutate()
    }
  }

  function handleEmailFlowSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (showVerificationSection) {
      handleVerifyEmailCode()
      return
    }

    handleRequestEmailCode()
  }

  if (!authBootstrapReady || !localAuthEnabled || authSetupRequired) {
    return null
  }

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={2}>
          {authTitle && <Typography level="h2">{authTitle}</Typography>}
          <Typography level="body-sm" textColor="text.tertiary">
            Use a passkey on this device, or choose email if you need a one-time code instead.
          </Typography>

          {passkeyError && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {passkeyError}
            </Alert>
          )}

          <Button
            variant="soft"
            color="primary"
            loading={signIn.isPending}
            onClick={() => signIn.mutate()}
            sx={{ width: '100%' }}
          >
            Sign In With Passkey
          </Button>

          <Divider>
            <Typography level="body-sm" textColor="text.tertiary">or</Typography>
          </Divider>

          {!emailFlowSelected ? (
            <Button
              variant="soft"
              color="neutral"
              onClick={() => setEmailFlowSelected(true)}
              sx={{ width: '100%' }}
            >
              Use Email
            </Button>
          ) : (
            <Box component="form" onSubmit={handleEmailFlowSubmit}>
              <Stack spacing={1.5}>
                <FormControl required>
                  <FormLabel>Email</FormLabel>
                  <Input
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => handleEmailChange(event.target.value)}
                    placeholder="admin@example.com"
                  />
                </FormControl>

                {inviteLinkState.isInvite && !emailCodeRequested && !emailCodeRequestError && (
                  <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                    {inviteLinkState.tenantName
                      ? `You were invited to ${inviteLinkState.tenantName}. Enter the one-time code from your email to continue.`
                      : 'You were invited to PrintStream. Enter the one-time code from your email to continue.'}
                  </Alert>
                )}

                {emailCodeRequestError && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    {emailCodeRequestError}
                  </Alert>
                )}

                {tenantOptions.length > 0 && (
                  <Stack spacing={1.5}>
                    <FormControl required>
                      <FormLabel>Tenant</FormLabel>
                      <Select
                        value={selectedTenantId}
                        onChange={(_event, value) => setSelectedTenantId(typeof value === 'string' ? value : null)}
                        placeholder="Choose a tenant"
                      >
                        {tenantOptions.map((tenant) => (
                          <Option key={tenant.id} value={tenant.id}>
                            {tenant.name}
                          </Option>
                        ))}
                      </Select>
                    </FormControl>

                    {!emailCodeRequested && !emailCodeRequestError && (
                      <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                        This email exists at multiple tenants. Choose the tenant you want to sign in to before requesting a code.
                      </Alert>
                    )}
                  </Stack>
                )}

                {emailCodeRequested && !emailCodeRequestError && (
                  <Alert
                    color={emailCodePreviewCode ? 'primary' : 'success'}
                    variant="soft"
                    startDecorator={emailCodePreviewCode ? <InfoOutlinedIcon /> : <CheckCircleOutlineRoundedIcon />}
                  >
                    {emailCodePreviewCode
                      ? 'Demo mode is enabled. Use the preview code below to finish signing in.'
                      : 'If the address matches a user, a one-time code has been sent.'}
                  </Alert>
                )}

                <Button
                  type="button"
                  onClick={handleRequestEmailCode}
                  loading={requestEmailCode.isPending}
                  disabled={!canRequestEmailCode}
                  sx={{ width: '100%' }}
                >
                  {showVerificationSection
                    ? 'Send another code'
                    : tenantOptions.length > 0
                      ? 'Email Me A Code For This Tenant'
                      : 'Email Me A Code'}
                </Button>

                {showVerificationSection && (
                  <Stack spacing={1.25}>
                    <FormControl required>
                      <FormLabel>Verification code</FormLabel>
                      <Input
                        value={emailCode}
                        autoFocus
                        autoComplete="one-time-code"
                        onChange={(event) => setEmailCode(event.target.value)}
                        placeholder="ABCD-EFGH"
                      />
                    </FormControl>

                    {emailCodeVerifyError && (
                      <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                        {emailCodeVerifyError}
                      </Alert>
                    )}

                    <Button
                      type="submit"
                      aria-label="Verify code"
                      loading={verifyEmailCode.isPending}
                      disabled={!canVerifyEmailCode}
                      sx={{ width: '100%' }}
                    >
                      Verify code
                    </Button>
                  </Stack>
                )}

                {emailCodePreviewCode && (
                  <FormControl required>
                    <FormLabel>Preview code</FormLabel>
                    <Input value={emailCodePreviewCode} readOnly />
                  </FormControl>
                )}
              </Stack>
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}

function readInviteLinkState(search: string): InviteLinkState {
  const params = new URLSearchParams(search)
  const authMode = params.get('authMode')
  const email = params.get('email')?.trim() ?? ''
  const tenantId = params.get('tenantId')?.trim() || null
  const tenantName = params.get('tenantName')?.trim() || null
  const isInvite = params.get('invite') === '1'

  return {
    email,
    isInvite,
    tenantId,
    tenantName,
    useEmailCode: authMode === 'email-code' || isInvite
  }
}