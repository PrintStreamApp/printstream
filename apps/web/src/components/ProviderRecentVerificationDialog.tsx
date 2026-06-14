import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded'
import { Alert, DialogContent, DialogTitle, ModalDialog, Typography } from '@mui/joy'
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

        {noProviderSupportsRecentVerification && (
          <Alert color="warning" variant="soft" startDecorator={<WarningAmberRoundedIcon />}>
            No enabled auth provider can re-verify this action yet.
          </Alert>
        )}
      </ModalDialog>
    </Modal>
  )
}