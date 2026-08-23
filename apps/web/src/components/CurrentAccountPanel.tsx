import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded'
import ForumRoundedIcon from '@mui/icons-material/ForumRounded'
import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined'
import ManageAccountsRoundedIcon from '@mui/icons-material/ManageAccountsRounded'
import ShieldRoundedIcon from '@mui/icons-material/ShieldRounded'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, Box, Button, Card, CardContent, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy'
import {
  extractErrorMessage,
  type AuthSessionListResponse,
  type AuthUserResponse,
  type UpdateCurrentAuthUserRequest
} from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/apiClient'
import { useAuthBootstrapQuery } from '../lib/authQuery'
import { useRuntimePolicy } from '../lib/runtimePolicy'
import { isPlatformWorkspacePath } from '../lib/workspaceRoute'
import { PageSectionHeading, pageSectionStackSpacing } from '../components/dashboard/PageSectionHeading'
import { SectionNav, type SectionNavEntry } from '../components/dashboard/SectionNav'
import { mobileSectionNavReserveSpace, sectionScrollMarginTop } from '../components/dashboard/SectionNav.constants'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'
import { AccountDestinationCard } from './AccountDestinationCard'
import {
  accountSlotHasContent,
  ACCOUNT_MESSAGES_SUBPATH,
  buildAccountPath,
  ACCOUNT_MESSAGES_SLOT
} from '../lib/accountSlots'
import { AuthSessionList } from './AuthSessionList'

/**
 * Self-service account surface for signed-in end users.
 *
 * This owns browser-session sign-out, active session review, and provider-
 * contributed account-security controls so those actions remain reachable even
 * when the actor cannot open the broader Settings screen.
 */
export function CurrentAccountPanel({
  showHeading = false,
  showSectionNav = false
}: {
  showHeading?: boolean
  showSectionNav?: boolean
} = {}) {
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { selfHosted } = useRuntimePolicy()
  const authBootstrapQuery = useAuthBootstrapQuery({ suppressGlobalErrorToast: true })

  const actorType = authBootstrapQuery.data?.actor.type ?? 'anonymous'
  const isAuthenticatedUser = actorType === 'user'
  const isSupportUser = isAuthenticatedUser && (authBootstrapQuery.data?.actor.isPlatformUser ?? false)
  const hasWorkspaceContext = authBootstrapQuery.data?.workspace != null
  const isPlatformAccountRoute = isPlatformWorkspacePath(location.pathname)
  const shouldOpenPlatformAccount = isSupportUser && hasWorkspaceContext && !isPlatformAccountRoute
  const authProviders = authBootstrapQuery.data?.providers ?? []
  const hasEnabledAuthProvider = authProviders.some((provider) => provider.enabled)

  const openPlatformAccountMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: () => apiFetch<void>('/api/auth/workspace-context', {
      method: 'POST',
      body: { workspaceId: null }
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-self-profile'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] })
      ])
      navigate('/platform/account', { replace: true })
    }
  })

  const authSessionsQuery = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => apiFetch<AuthSessionListResponse>('/api/auth/sessions'),
    enabled: isAuthenticatedUser && !shouldOpenPlatformAccount,
    meta: { suppressGlobalErrorToast: true }
  })
  const selfProfileQuery = useQuery({
    queryKey: ['auth-self-profile'],
    queryFn: () => apiFetch<AuthUserResponse>('/api/auth/me'),
    enabled: isAuthenticatedUser && !shouldOpenPlatformAccount,
    meta: { suppressGlobalErrorToast: true }
  })
  const [profileDisplayName, setProfileDisplayName] = useState('')

  useEffect(() => {
    const user = selfProfileQuery.data?.user
    if (!user) return
    setProfileDisplayName(user.displayName ?? '')
  }, [selfProfileQuery.data?.user])

  async function handleProfileMutationSuccess(data: AuthUserResponse) {
    setProfileDisplayName(data.user.displayName ?? '')
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-self-profile'] }),
      queryClient.invalidateQueries({ queryKey: ['auth-users'] })
    ])
  }

  const revokeAuthSessionMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (sessionId: string) =>
      apiFetch<void>(`/api/auth/sessions/${sessionId}/revoke`, {
        method: 'POST'
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['auth-sessions'] })
    }
  })
  const updateProfileMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: (body: UpdateCurrentAuthUserRequest) =>
      apiFetch<AuthUserResponse>('/api/auth/me', {
        method: 'PATCH',
        body
      }),
    onSuccess: handleProfileMutationSuccess
  })
  const logoutMutation = useMutation({
    meta: { suppressGlobalErrorToast: true },
    mutationFn: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
    onSuccess: async () => {
      // Cloud: leave the app entirely, a hard load of the marketing home
      // drops all signed-in state (WS connection, caches, sticky entered-app
      // branch) and boots the light marketing bundle. Self-hosted has no
      // marketing surface, so stay in the SPA on the sign-in wall.
      if (!selfHosted) {
        window.location.assign('/')
        return
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-bootstrap'] }),
        queryClient.invalidateQueries({ queryKey: ['local-auth-status'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-local-self-passkeys'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-self-profile'] })
      ])
      navigate('/auth', { replace: true })
    }
  })

  const bootstrapError = authBootstrapQuery.error
    ? extractErrorMessage(authBootstrapQuery.error)
    : null
  const logoutError = logoutMutation.error
    ? extractErrorMessage(logoutMutation.error)
    : null
  const openPlatformAccountError = openPlatformAccountMutation.error
    ? extractErrorMessage(openPlatformAccountMutation.error)
    : null
  const profileError = selfProfileQuery.error
    ? extractErrorMessage(selfProfileQuery.error)
    : updateProfileMutation.error
      ? extractErrorMessage(updateProfileMutation.error)
      : null
  const sessionsError = authSessionsQuery.error
    ? extractErrorMessage(authSessionsQuery.error)
    : revokeAuthSessionMutation.error
      ? extractErrorMessage(revokeAuthSessionMutation.error)
      : null
  const sessions = authSessionsQuery.data?.sessions ?? []
  const currentProfile = selfProfileQuery.data?.user ?? null
  const normalizedDisplayName = profileDisplayName.trim() ? profileDisplayName.trim() : null
  const hasProfileChanges = currentProfile != null && normalizedDisplayName !== currentProfile.displayName
  const showsAccountSecuritySection = isAuthenticatedUser && hasEnabledAuthProvider
  const accountHeadingTitle = isAuthenticatedUser
    ? 'User account'
    : actorType === 'service-account'
      ? 'Service account session'
      : 'Account'
  const accountHeadingDescription = isAuthenticatedUser
    ? 'Update your profile, manage your current browser session, review other signed-in devices, and control provider-managed sign-in methods.'
    : actorType === 'service-account'
      ? 'This browser is authenticated with a service-account token rather than a user session.'
      : 'Sign in to manage this account.'
  const sections = useMemo<SectionNavEntry[]>(() => {
    if (!showSectionNav || !isAuthenticatedUser) {
      return []
    }

    const nextSections: SectionNavEntry[] = [
      { id: 'general', label: 'General' },
      { id: 'profile', label: 'Profile' }
    ]

    if (showsAccountSecuritySection) {
      nextSections.push({ id: 'security', label: 'Security' })
    }

    nextSections.push({ id: 'sessions', label: 'Sessions' })
    return nextSections
  }, [isAuthenticatedUser, showSectionNav, showsAccountSecuritySection])

  async function handleProfileSave() {
    if (!currentProfile) {
      return
    }

    await updateProfileMutation.mutateAsync({
      displayName: normalizedDisplayName
    })
  }

  /**
   * Messages is the only destination card left, and only for people who have no
   * other way in.
   *
   * There is no billing card: the account's own scope ("Billing and licensing")
   * is a destination in the context switcher now, so a card here duplicated a
   * button the shell already shows on every page.
   *
   * There is no messages card for an OPERATOR either: the platform nav carries
   * its own Messages tab, so the card restated a tab they can already see. It
   * stays for everyone else, whose workspaces do not all have that tab.
   *
   * It renders only when a plugin fills the slot: empty in a public build,
   * where the route does not exist and the card would be a dead end.
   */
  const showsMessagesDestination = !isSupportUser && accountSlotHasContent(ACCOUNT_MESSAGES_SLOT)
  const destinationsSection = showsMessagesDestination ? (
    <Box sx={{ scrollMarginTop: sectionScrollMarginTop }}>
      <AccountDestinationCard
        to={buildAccountPath(location.pathname, ACCOUNT_MESSAGES_SUBPATH)}
        icon={<ForumRoundedIcon />}
        title="Messages"
        description="Your conversations with the PrintStream team: questions, feedback, and bug reports."
      />
    </Box>
  ) : null

  if (shouldOpenPlatformAccount) {
    return (
      <Stack spacing={pageSectionStackSpacing}>
        {showHeading && <Typography level="h3">Account</Typography>}

        {bootstrapError && (
          <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
            {bootstrapError}
          </Alert>
        )}

        {destinationsSection}

        <PageSectionHeading
          icon={<ManageAccountsRoundedIcon />}
          title="Open your platform account"
          description="Support users manage their own account only from the platform workspace. Continue there to view or edit your account."
        />

        <Card variant="outlined">
          <CardContent>
            <Stack spacing={1.5}>
              <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
                Support users manage their own account only from the platform workspace.
              </Alert>
              {openPlatformAccountError && (
                <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                  {openPlatformAccountError}
                </Alert>
              )}
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} justifyContent="flex-end">
                <Button onClick={() => openPlatformAccountMutation.mutate()} loading={openPlatformAccountMutation.isPending}>
                  Open platform account
                </Button>
              </Stack>
            </Stack>
          </CardContent>
        </Card>
      </Stack>
    )
  }

  return (
    <Stack spacing={pageSectionStackSpacing} sx={{ pb: showSectionNav ? { xs: mobileSectionNavReserveSpace, sm: 0 } : undefined }}>
      {sections.length > 0 && <SectionNav aria-label="Account sections" sections={sections} mb={0} />}

      {showHeading && (
        <AccountPageHeading
          title={accountHeadingTitle}
          description={accountHeadingDescription}
          actions={isAuthenticatedUser ? (
            <Button
              variant="soft"
              color="neutral"
              loading={logoutMutation.isPending}
              onClick={() => logoutMutation.mutate()}
              sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
            >
              Sign out
            </Button>
          ) : undefined}
        />
      )}

      {bootstrapError && (
        <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
          {bootstrapError}
        </Alert>
      )}

      <Box id="general" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
        <Stack spacing={1.25}>
          {!showHeading && (
            <PageSectionHeading
              icon={<ManageAccountsRoundedIcon />}
              title={accountHeadingTitle}
              description={accountHeadingDescription}
              actions={isAuthenticatedUser ? (
                <Button
                  size="sm"
                  variant="soft"
                  color="neutral"
                  loading={logoutMutation.isPending}
                  onClick={() => logoutMutation.mutate()}
                >
                  Sign out
                </Button>
              ) : undefined}
            />
          )}

          {logoutError && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {logoutError}
            </Alert>
          )}

          {actorType === 'service-account' && (
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              Service-account access is bearer-token based. Remove that token from the client or browser context to fully sign out.
            </Alert>
          )}
        </Stack>
      </Box>

      {destinationsSection}

      {isAuthenticatedUser && (
        <Box id="profile" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
          <Stack spacing={1.25}>
            <PageSectionHeading
              icon={<BadgeRoundedIcon />}
              title="Profile"
              description="How your account appears to everyone else in PrintStream."
            />

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                {profileError && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    {profileError}
                  </Alert>
                )}

                {selfProfileQuery.isLoading && !currentProfile ? (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading your profile…
                  </Typography>
                ) : (
                  <Stack spacing={1.25}>
                    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ xs: 'stretch', md: 'flex-end' }}>
                      <FormControl sx={{ flex: 1 }}>
                        <FormLabel>Display name</FormLabel>
                        <Input
                          value={profileDisplayName}
                          onChange={(event) => setProfileDisplayName(event.target.value)}
                          onInput={(event) => setProfileDisplayName((event.target as HTMLInputElement).value)}
                          disabled={updateProfileMutation.isPending}
                          placeholder="Optional"
                        />
                      </FormControl>
                      <Button
                        onClick={() => void handleProfileSave()}
                        loading={updateProfileMutation.isPending}
                        disabled={!hasProfileChanges}
                        sx={{ flexShrink: 0 }}
                      >
                        Save display name
                      </Button>
                    </Stack>

                    {hasProfileChanges && !updateProfileMutation.isPending && (
                      <Alert color="primary" variant="soft" startDecorator={<InfoOutlinedIcon />}>
                        Your display name update only affects how your account appears inside PrintStream.
                      </Alert>
                    )}
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>
          </Stack>
        </Box>
      )}

      {showsAccountSecuritySection && (
        <Box id="security" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
          <Stack spacing={1.25}>
            <PageSectionHeading
              icon={<ShieldRoundedIcon />}
              title="Security"
              description="Review and manage the sign-in methods trusted on this account."
            />

            <StaticPluginSlot
              name="account.security"
              context={{
                actorType,
                currentProfile,
                profileLoading: selfProfileQuery.isLoading,
                authProviders,
                authBootstrapReady: authBootstrapQuery.isSuccess
              }}
            />
          </Stack>
        </Box>
      )}

      {isAuthenticatedUser && (
        <Box id="sessions" sx={{ scrollMarginTop: sectionScrollMarginTop }}>
          <Stack spacing={1.25}>
            <PageSectionHeading
              icon={<DevicesRoundedIcon />}
              title="Active sessions"
              description="Review other browsers or devices that still have access to this account."
              count={sessions.length}
            />

          <Card variant="outlined">
            <CardContent>
              <Stack spacing={1.5}>
                {sessionsError && (
                  <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
                    {sessionsError}
                  </Alert>
                )}

                {!authSessionsQuery.isLoading && sessions.length > 0 && (
                  <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
                    Review any browser or device you no longer recognize and revoke it here.
                  </Alert>
                )}

                {authSessionsQuery.isLoading ? (
                  <Typography level="body-sm" textColor="text.tertiary">
                    Loading active sessions…
                  </Typography>
                ) : (
                  <AuthSessionList
                    sessions={sessions}
                    emptyMessage="No active sessions found."
                    revokingSessionId={revokeAuthSessionMutation.isPending ? revokeAuthSessionMutation.variables ?? null : null}
                    onRevoke={(sessionId) => revokeAuthSessionMutation.mutate(sessionId)}
                  />
                )}
              </Stack>
            </CardContent>
          </Card>
          </Stack>
        </Box>
      )}
    </Stack>
  )
}

/**
 * The panel's own page heading. Distinct from {@link PageSectionHeading}, which titles the
 * sections BELOW it, this one has no icon, count, or rule so the sections cannot outweigh it.
 */
function AccountPageHeading({
  title,
  description,
  actions
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <Stack
      direction={{ xs: 'column', sm: 'row' }}
      spacing={1.25}
      justifyContent="space-between"
      alignItems={{ xs: 'flex-start', sm: 'flex-start' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography level="h3">{title}</Typography>
        {description && (
          <Typography level="body-sm" textColor="text.tertiary">
            {description}
          </Typography>
        )}
      </Box>
      {actions}
    </Stack>
  )
}