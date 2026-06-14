import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Sheet, Stack, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { extractErrorMessage, type AuthBootstrap, type AuthUser, type AuthUserPasskey, type AuthUserPasskeyListResponse } from '@printstream/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import React from 'react'
import { apiFetch } from '../../lib/apiClient'
import { AuthPasskeyList } from '../../components/AuthPasskeyList'
import { DialogSection } from '../../components/DialogSection'

/** Local-auth credential controls for a managed user. */
export function AuthLocalUserCredentialsSection({
  user,
  authProviders = [],
  mutatingLifecycle = false,
  canViewUserPasskeys = false,
  canEditUserPasskeys = false,
  canRevokeUserPasskeys = false
}: {
  user?: AuthUser
  authProviders?: AuthBootstrap['providers']
  mutatingLifecycle?: boolean
  canViewUserPasskeys?: boolean
  canEditUserPasskeys?: boolean
  canRevokeUserPasskeys?: boolean
}) {
  const queryClient = useQueryClient()
  const localAuthEnabled = authProviders.some(
    (provider) => provider.id === 'auth-local' && provider.enabled && provider.capabilities.adminUserCredentials
  )
  const userPasskeysQuery = useQuery({
    queryKey: ['auth-local-user-passkeys', user?.id ?? null],
    queryFn: () => apiFetch<AuthUserPasskeyListResponse>(`/api/plugins/auth-local/users/${user?.id}/passkeys`),
    enabled: Boolean(user?.id && localAuthEnabled && canViewUserPasskeys)
  })
  const revokeUserPasskeyMutation = useMutation({
    mutationFn: ({ userId, passkeyId }: { userId: string; passkeyId: string }) =>
      apiFetch<void>(`/api/plugins/auth-local/users/${userId}/passkeys/${passkeyId}/revoke`, {
        method: 'POST'
      }),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['auth-local-user-passkeys', variables.userId] }),
        queryClient.invalidateQueries({ queryKey: ['auth-users'] }),
        queryClient.invalidateQueries({ queryKey: ['auth-management-status'] }),
        queryClient.invalidateQueries({ queryKey: ['local-auth-status'] })
      ])
    }
  })
  const updateUserPasskeyMutation = useMutation({
    mutationFn: ({ userId, passkeyId, nickname }: { userId: string; passkeyId: string; nickname: string | null }) =>
      apiFetch<{ passkey: AuthUserPasskey }>(`/api/plugins/auth-local/users/${userId}/passkeys/${passkeyId}`, {
        method: 'PATCH',
        body: { nickname }
      }),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['auth-local-user-passkeys', variables.userId] })
    }
  })

  if (!user || !localAuthEnabled || !canViewUserPasskeys) {
    return null
  }

  const passkeys = userPasskeysQuery.data?.passkeys ?? []
  const passkeysError = updateUserPasskeyMutation.error
    ? extractErrorMessage(updateUserPasskeyMutation.error)
    : revokeUserPasskeyMutation.error
      ? extractErrorMessage(revokeUserPasskeyMutation.error)
      : userPasskeysQuery.error
        ? extractErrorMessage(userPasskeysQuery.error)
        : null

  return (
    <DialogSection
      title="Passkeys"
      description="Review registered passkeys and revoke any credential that should no longer be trusted."
      wrapInSheet={false}
    >
      <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 'lg' }}>
        <Stack spacing={1}>
          {passkeysError && (
            <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
              {passkeysError}
            </Alert>
          )}

          {userPasskeysQuery.isLoading ? (
            <Typography level="body-sm" textColor="text.tertiary">
              Loading passkeys…
            </Typography>
          ) : passkeys.length === 0 ? (
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              No passkeys registered yet. This user will need an emailed sign-in code to sign in.
            </Alert>
          ) : (
            <AuthPasskeyList
              passkeys={passkeys}
              emptyMessage="No passkeys registered yet. This user will need an emailed sign-in code to sign in."
              renamingPasskeyId={updateUserPasskeyMutation.isPending ? updateUserPasskeyMutation.variables?.passkeyId ?? null : null}
              revokingPasskeyId={revokeUserPasskeyMutation.isPending ? revokeUserPasskeyMutation.variables?.passkeyId ?? null : null}
              onRename={(passkeyId, nickname) => {
                if (!canEditUserPasskeys) return
                updateUserPasskeyMutation.mutate({ userId: user.id, passkeyId, nickname })
              }}
              onRevoke={(passkeyId) => {
                if (!canRevokeUserPasskeys) return
                revokeUserPasskeyMutation.mutate({ userId: user.id, passkeyId })
              }}
              actionsDisabled={mutatingLifecycle || (!canEditUserPasskeys && !canRevokeUserPasskeys)}
              cardVariant="outlined"
            />
          )}
        </Stack>
      </Sheet>
    </DialogSection>
  )
}