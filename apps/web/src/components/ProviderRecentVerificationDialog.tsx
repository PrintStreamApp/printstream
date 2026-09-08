import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, Button, DialogActions, DialogContent, DialogTitle, ModalDialog, Typography } from '@mui/joy'
import type { AuthBootstrap } from '@printstream/shared'
import React from 'react'
import { BackAwareModal as Modal } from './BackAwareModal'
import { StaticPluginSlot } from '../plugin/StaticPluginSlot'

/**
 * Generic host for provider-owned recent-verification controls.
 *
 * Sensitive actions stay owned by the initiating feature, but the verification
 * UI itself is delegated to auth-provider slots so future providers can plug in
 * their own re-auth method without changing the host dialog shell.
 */
export function ProviderRecentVerificationDialog({
  open,
  title,
  description,
  email,
  authProviders,
  onClose,
  onVerified
}: {
  open: boolean
  title: string
  description: string
  email: string
  authProviders: AuthBootstrap['providers']
  onClose: () => void
  onVerified: () => void | Promise<void>
}) {
  const noProviderSupportsRecentVerification = authProviders.every(
    (provider) => (provider.capabilities.recentVerificationMethods?.length ?? 0) === 0
  )

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog variant="outlined" sx={{ width: 'min(560px, 100%)' }}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" textColor="text.tertiary">
            {description}
          </Typography>
        </DialogContent>

        <StaticPluginSlot
          name="auth.recentVerification"
          context={{
            authProviders,
            email,
            onClose,
            onVerified
          }}
        />

        {/* The dismiss belongs to this branch, not to the dialog: every other exit here is the
            slot's own Cancel, and the slot renders NOTHING when no provider advertises a method,
            leaving a warning and no buttons at all. That was survivable while a click outside closed
            a dialog and is not now that only a deliberate gesture does (see `BackAwareModal`).
            Deliberately not a `ModalClose`: the slot disables its Cancel while a verification is in
            flight (a passkey ceremony, an emailed code), and an always-enabled X above it would tear
            the dialog down mid-ceremony, which is the case the slot is careful about. */}
        {noProviderSupportsRecentVerification && (
          <>
            <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
              No enabled auth provider can re-verify this action yet.
            </Alert>
            <DialogActions>
              <Button variant="plain" color="neutral" onClick={onClose}>Close</Button>
            </DialogActions>
          </>
        )}
      </ModalDialog>
    </Modal>
  )
}