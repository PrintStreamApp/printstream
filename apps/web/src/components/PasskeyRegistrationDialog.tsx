import { useEffect, useState } from 'react'
import {
  Button,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormLabel,
  Input,
  ModalDialog,
  Option,
  Select,
  Typography
} from '@mui/joy'
import { isNativeDesktop } from '@printstream/shared'
import React from 'react'
import type { PasskeyRegistrationTarget } from '../lib/passkeyRegistrationOptions'
import { BackAwareModal as Modal } from './BackAwareModal'

export function PasskeyRegistrationDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  loading,
  error,
  onClose,
  onConfirm
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  cancelLabel?: string
  loading: boolean
  error: string | null
  onClose: () => void
  onConfirm: (nickname: string | null, target: PasskeyRegistrationTarget) => void
}) {
  const [nickname, setNickname] = useState('')
  const [target, setTarget] = useState<PasskeyRegistrationTarget>('local-device')
  const showTargetChoice = isNativeDesktop()

  useEffect(() => {
    if (!open) {
      setNickname('')
      setTarget('local-device')
    }
  }, [open])

  return (
    <Modal open={open} onClose={() => { if (!loading) onClose() }}>
      <ModalDialog variant="outlined" sx={{ width: 'min(520px, 100%)' }}>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <Typography level="body-sm" textColor="text.tertiary">
            {description}
          </Typography>
        </DialogContent>

        <FormControl size="sm">
          <FormLabel>Passkey name</FormLabel>
          <Input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            placeholder="Desk laptop"
            autoFocus
            disabled={loading}
          />
          <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 0.75 }}>
            Optional. If you leave this blank, PrintStream will show a device-based default label.
          </Typography>
        </FormControl>

        {showTargetChoice && (
          <FormControl size="sm">
            <FormLabel>Save passkey on</FormLabel>
            <Select
              value={target}
              onChange={(_, value) => {
                if (value) {
                  setTarget(value)
                }
              }}
              disabled={loading}
            >
              <Option value="local-device">This device (recommended)</Option>
              <Option value="another-device">Another device or security key</Option>
            </Select>
          </FormControl>
        )}

        {error && (
          <Typography level="body-sm" color="danger">
            {error}
          </Typography>
        )}

        <DialogActions>
          <Button variant="plain" color="neutral" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            loading={loading}
            onClick={() => onConfirm(
              nickname.trim() ? nickname.trim() : null,
              showTargetChoice ? target : 'another-device'
            )}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  )
}
