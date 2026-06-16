import { Alert, Avatar, Box, Button, Card, CardContent, Chip, FormControl, FormLabel, Input, Stack, Tooltip, Typography } from '@mui/joy'
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import CloudRoundedIcon from '@mui/icons-material/CloudRounded'
import DevicesRoundedIcon from '@mui/icons-material/DevicesRounded'
import KeyRoundedIcon from '@mui/icons-material/KeyRounded'
import PhoneIphoneRoundedIcon from '@mui/icons-material/PhoneIphoneRounded'
import React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AuthUserPasskey } from '@printstream/shared'
import { describePasskey, type PasskeyProviderKind, type PasskeyVisualKind } from '../lib/passkeyMetadata'

/**
 * Reusable passkey list with inline nickname editing and revoke actions.
 */
export function AuthPasskeyList({
  passkeys,
  emptyMessage,
  renamingPasskeyId,
  revokingPasskeyId,
  onRename,
  onRevoke,
  actionsDisabled = false,
  revokeActionsDisabled = false,
  cardVariant = 'soft'
}: {
  passkeys: AuthUserPasskey[]
  emptyMessage: string
  renamingPasskeyId: string | null
  revokingPasskeyId: string | null
  onRename: (passkeyId: string, nickname: string | null) => void
  onRevoke: (passkeyId: string) => void
  actionsDisabled?: boolean
  revokeActionsDisabled?: boolean
  cardVariant?: 'soft' | 'outlined'
}) {
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null)
  const [draftNickname, setDraftNickname] = useState('')
  const previousRenamingPasskeyIdRef = useRef<string | null>(null)

  const editingPasskey = useMemo(
    () => passkeys.find((passkey) => passkey.id === editingPasskeyId) ?? null,
    [editingPasskeyId, passkeys]
  )

  useEffect(() => {
    const previousRenamingPasskeyId = previousRenamingPasskeyIdRef.current

    if (!editingPasskeyId) return
    if (!editingPasskey) {
      setEditingPasskeyId(null)
      setDraftNickname('')
      previousRenamingPasskeyIdRef.current = renamingPasskeyId
      return
    }
    if (renamingPasskeyId === editingPasskeyId) {
      previousRenamingPasskeyIdRef.current = renamingPasskeyId
      return
    }

    const renameJustFinished = previousRenamingPasskeyId === editingPasskeyId && renamingPasskeyId == null

    if (renameJustFinished && normalizePasskeyNickname(editingPasskey.nickname) === normalizePasskeyNickname(draftNickname)) {
      setEditingPasskeyId(null)
      setDraftNickname('')
    }

    previousRenamingPasskeyIdRef.current = renamingPasskeyId
  }, [draftNickname, editingPasskey, editingPasskeyId, renamingPasskeyId])

  if (passkeys.length === 0) {
    return (
      <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
        {emptyMessage}
      </Alert>
    )
  }

  return (
    <Stack spacing={1}>
      {passkeys.map((passkey) => {
        const passkeyDetails = describePasskey(passkey)
        const isEditing = editingPasskeyId === passkey.id
        const isRenaming = renamingPasskeyId === passkey.id
        const isRevoking = revokingPasskeyId === passkey.id
        const normalizedNickname = normalizePasskeyNickname(passkey.nickname)
        const normalizedDraftNickname = normalizePasskeyNickname(draftNickname)
        const renameDisabled = actionsDisabled || isRevoking || isRenaming || normalizedDraftNickname === normalizedNickname

        return (
          <Card key={passkey.id} variant={cardVariant}>
            <CardContent>
              <Stack spacing={1.25}>
                <Stack
                  direction="column"
                  spacing={1.25}
                  alignItems="flex-start"
                >
                  <Stack direction="row" spacing={1.25} sx={{ minWidth: 0, flex: 1, alignItems: 'flex-start' }}>
                    <Avatar
                      variant="soft"
                      color={avatarColorForPasskey(passkeyDetails.visualKind)}
                      sx={{ width: 52, height: 52, borderRadius: 'md', flexShrink: 0 }}
                    >
                      {avatarContentForPasskey(passkeyDetails.providerKind, passkeyDetails.visualKind)}
                    </Avatar>

                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
                        <Typography level="title-sm">{normalizedNickname ?? passkeyDetails.defaultLabel}</Typography>
                        <Chip size="sm" variant="soft" color="neutral">{passkeyDetails.providerLabel ?? passkeyDetails.walletLabel}</Chip>
                        {passkey.backedUp && (
                          <Tooltip
                            arrow
                            placement="top"
                            variant="soft"
                            size="sm"
                            title="The authenticator reports this passkey is backed up and can usually be recovered from its synced passkey provider."
                          >
                            <Chip size="sm" variant="soft" color="success">Backed up</Chip>
                          </Tooltip>
                        )}
                      </Stack>
                      <Typography level="body-xs" textColor="text.tertiary">
                        {passkeyDetails.providerLabel
                          ? `${passkeyDetails.walletLabel} · ${passkeyDetails.authenticatorLabel}`
                          : passkeyDetails.authenticatorLabel}
                      </Typography>
                      <Typography level="body-xs" textColor="text.tertiary">
                        Added {formatAuthDateTime(passkey.createdAt)}
                      </Typography>
                      <Typography level="body-xs" textColor="text.tertiary">
                        {passkey.lastUsedAt
                          ? `Last used ${formatAuthDateTime(passkey.lastUsedAt)}`
                          : 'Last used never on this site'}
                      </Typography>
                    </Box>
                  </Stack>

                  {!isEditing && (
                    <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
                      <Button
                        size="sm"
                        variant="soft"
                        color="neutral"
                        disabled={actionsDisabled || isRevoking}
                        onClick={() => {
                          setEditingPasskeyId(passkey.id)
                          setDraftNickname(passkey.nickname ?? '')
                        }}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="plain"
                        color="danger"
                        loading={isRevoking}
                        disabled={actionsDisabled || revokeActionsDisabled || isRenaming}
                        onClick={() => onRevoke(passkey.id)}
                      >
                        Revoke
                      </Button>
                    </Stack>
                  )}
                </Stack>

                {isEditing && (
                  <Stack
                    direction="column"
                    spacing={1}
                    alignItems="stretch"
                  >
                    <FormControl size="sm" sx={{ flex: 1, minWidth: 0 }}>
                      <FormLabel>Passkey nickname</FormLabel>
                      <Input
                        value={draftNickname}
                        placeholder="Desk laptop"
                        disabled={actionsDisabled || isRevoking || isRenaming}
                        onChange={(event) => setDraftNickname(event.target.value)}
                      />
                    </FormControl>
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button
                        size="sm"
                        variant="plain"
                        color="neutral"
                        disabled={isRenaming}
                        onClick={() => {
                          setEditingPasskeyId(null)
                          setDraftNickname('')
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        loading={isRenaming}
                        disabled={renameDisabled}
                        onClick={() => onRename(passkey.id, normalizedDraftNickname)}
                      >
                        Save name
                      </Button>
                    </Stack>
                  </Stack>
                )}
              </Stack>
            </CardContent>
          </Card>
        )
      })}
    </Stack>
  )
}

function normalizePasskeyNickname(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function formatAuthDateTime(value: string): string {
  return new Date(value).toLocaleString()
}

function iconForPasskey(kind: PasskeyVisualKind) {
  switch (kind) {
    case 'synced':
      return <CloudRoundedIcon />
    case 'phone':
      return <PhoneIphoneRoundedIcon />
    case 'security-key':
      return <KeyRoundedIcon />
    case 'device':
      return <DevicesRoundedIcon />
    default:
      return <KeyRoundedIcon />
  }
}

function avatarContentForPasskey(providerKind: PasskeyProviderKind, visualKind: PasskeyVisualKind) {
  switch (providerKind) {
    case 'bitwarden':
      return (
        <Box
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: 1,
            height: 1,
            bgcolor: '#175ddc',
            color: '#fff',
            borderRadius: 'md',
            fontSize: '0.7rem',
            fontWeight: 'lg',
            letterSpacing: '0.08em'
          }}
        >
          BW
        </Box>
      )
    case 'google-password-manager':
      return (
        <Box
          sx={{
            display: 'grid',
            placeItems: 'center',
            width: 1,
            height: 1,
            bgcolor: '#fff',
            color: '#1f2937',
            borderRadius: '50%',
            border: '4px solid #4285f4',
            borderTopColor: '#ea4335',
            borderRightColor: '#fbbc05',
            borderBottomColor: '#34a853',
            fontSize: '0.75rem',
            fontWeight: 'lg',
            letterSpacing: '0.02em'
          }}
        >
          G
        </Box>
      )
    default:
      return iconForPasskey(visualKind)
  }
}

function avatarColorForPasskey(kind: PasskeyVisualKind): 'neutral' | 'primary' | 'success' | 'warning' {
  switch (kind) {
    case 'synced':
      return 'success'
    case 'phone':
      return 'primary'
    case 'security-key':
      return 'warning'
    case 'device':
      return 'primary'
    default:
      return 'neutral'
  }
}