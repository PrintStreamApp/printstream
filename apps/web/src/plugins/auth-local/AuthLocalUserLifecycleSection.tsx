import CheckCircleOutlineRoundedIcon from '@mui/icons-material/CheckCircleOutlineRounded'
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded'
import { Alert, Button, Chip, DialogActions, DialogContent, DialogTitle, FormControl, FormLabel, Input, ModalClose, Stack, Typography } from '@mui/joy'
import { extractErrorMessage, type AuthBootstrap, type AuthUser, type AuthUserInviteResponse, type AuthUserInviteResult } from '@printstream/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import React, { useState } from 'react'
import type { ReactNode } from 'react'
import { apiFetch } from '../../lib/apiClient'
import { authQueryKeys, readCurrentAuthBootstrapScopeKey } from '../../lib/authQuery'
import { canSendAuthUserInvite } from '../../lib/authUi'
import { getBrowserTimeZone } from '../../lib/time'
import { BackAwareModal as Modal } from '../../components/BackAwareModal'
import { ScrollableDialogBody, ScrollableModalDialog } from '../../components/ScrollableDialog'

type CreatedUserInvite = {
  email: string
  displayName: string | null
  inviteUrl: string
  invite: AuthUserInviteResult
}

/** Local-auth admin lifecycle actions for a managed user. */
export function AuthLocalUserLifecycleSection({
  user,
  authProviders = [],
  mutatingLifecycle = false,
  canSendUserInvites = false,
  extraActions
}: {
  user?: AuthUser
  authProviders?: AuthBootstrap['providers']
  mutatingLifecycle?: boolean
  canSendUserInvites?: boolean
  extraActions?: ReactNode
}) {
  const queryClient = useQueryClient()
  const [createdUserInvite, setCreatedUserInvite] = useState<CreatedUserInvite | null>(null)
  const localAuthEnabled = authProviders.some(
    (provider) => provider.id === 'auth-local' && provider.enabled && provider.capabilities.adminUserProvisioning
  )
  const authBootstrap = queryClient.getQueryData<AuthBootstrap>(authQueryKeys.bootstrapScoped(readCurrentAuthBootstrapScopeKey()))

  const inviteUserMutation = useMutation({
    mutationFn: ({ inviteUrl, userId }: { inviteUrl: string; userId: string }) => {
      const timeZone = getBrowserTimeZone()
      return apiFetch<AuthUserInviteResponse>(`/api/plugins/auth-local/users/${userId}/invite`, {
        method: 'POST',
        body: { inviteUrl },
        headers: timeZone ? { 'X-PrintStream-Time-Zone': timeZone } : undefined
      })
    },
    onSuccess: async (data, variables) => {
      if (!user) {
        return
      }
      setCreatedUserInvite({
        email: user.email,
        displayName: user.displayName,
        inviteUrl: variables.inviteUrl,
        invite: data.invite
      })
      await queryClient.invalidateQueries({ queryKey: ['auth-users'] })
    }
  })

  if (!user || !localAuthEnabled || !canSendUserInvites) {
    return null
  }

  const canSendInvite = canSendAuthUserInvite({
    loginDisabled: user.loginDisabled
  })

  return (
    <>
      <Stack spacing={1}>
        {inviteUserMutation.error && (
          <Alert color="danger" variant="soft" startDecorator={<ErrorOutlineRoundedIcon />}>
            {extractErrorMessage(inviteUserMutation.error)}
          </Alert>
        )}

        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
          <Button
            size="sm"
            variant="soft"
            color="neutral"
            loading={inviteUserMutation.isPending}
            disabled={mutatingLifecycle || !canSendInvite}
            onClick={() => inviteUserMutation.mutate({
              userId: user.id,
              inviteUrl: buildAuthInviteUrl({
                email: user.email,
                tenantId: authBootstrap?.tenant?.id,
                tenantName: authBootstrap?.tenant?.name
              })
            })}
          >
            Send invite
          </Button>
          {extraActions}
        </Stack>
      </Stack>

      {createdUserInvite && (
        <Modal open onClose={() => setCreatedUserInvite(null)}>
          <ScrollableModalDialog sx={{ width: 'min(680px, 100%)' }}>
            <ModalClose />
            <DialogTitle>User invite sent</DialogTitle>
            <DialogContent>
              <Stack spacing={1}>
                <Typography level="body-sm" textColor="text.tertiary">
                  {createdUserInvite.displayName?.trim() || createdUserInvite.email} can open the invite link below, enter the emailed code, and finish setup from the account page.
                </Typography>
                <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                  <Chip size="sm" variant="soft" color="primary">{createdUserInvite.email}</Chip>
                  <Chip size="sm" variant="soft" color="neutral">
                    Expires {new Date(createdUserInvite.invite.expiresAt).toLocaleString()}
                  </Chip>
                </Stack>
              </Stack>
            </DialogContent>

            <ScrollableDialogBody>
              <Stack spacing={1.5}>
                <Alert color="success" variant="soft" startDecorator={<CheckCircleOutlineRoundedIcon />}>
                  {createdUserInvite.invite.previewCode
                    ? 'The invite was generated in demo mode. Share the invite link and preview code below with the user.'
                    : 'The invite email has been queued for delivery. You can also share the invite link below directly.'}
                </Alert>
                <FormControl>
                  <FormLabel>Invite link</FormLabel>
                  <Input value={createdUserInvite.inviteUrl} readOnly />
                </FormControl>
                {createdUserInvite.invite.previewCode && (
                  <FormControl>
                    <FormLabel>Preview code</FormLabel>
                    <Input value={createdUserInvite.invite.previewCode} readOnly />
                  </FormControl>
                )}
              </Stack>
            </ScrollableDialogBody>

            <DialogActions>
              <Button variant="plain" color="neutral" onClick={() => setCreatedUserInvite(null)}>
                Close
              </Button>
            </DialogActions>
          </ScrollableModalDialog>
        </Modal>
      )}
    </>
  )
}

function buildAuthInviteUrl(input: {
  email: string
  tenantId?: string | null
  tenantName?: string | null
}): string {
  const inviteUrl = new URL('/auth', window.location.origin)
  inviteUrl.searchParams.set('invite', '1')
  inviteUrl.searchParams.set('authMode', 'email-code')
  inviteUrl.searchParams.set('email', input.email)
  if (input.tenantId) {
    inviteUrl.searchParams.set('tenantId', input.tenantId)
  }
  if (input.tenantName) {
    inviteUrl.searchParams.set('tenantName', input.tenantName)
  }
  return inviteUrl.toString()
}